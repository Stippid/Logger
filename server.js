const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Remove timeouts for massive file transfers (GBs)
server.timeout = 0; 

app.use(express.json());
app.use(cors());
app.use(express.static(__dirname)); 

// Ensure uploads directory exists on D: drive
const uploadDir = 'D:\\Logger\\uploads'; // Use double backslash for Windows paths in JavaScript
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Serve uploaded files
app.use('/uploads', express.static(uploadDir));

// Configure Multer for file uploads (No size limits, streams to disk)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// Database Setup
const db = new sqlite3.Database('./logs.db');

db.serialize(() => {
    // Existing Tables (Untouched)
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT, date TEXT, time TEXT, timestamp INTEGER)");
    
    // New Chat Tables
    db.run("CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, is_group BOOLEAN, name TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS participants (conversation_id INTEGER, user_id INTEGER)");
    db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER, sender_id INTEGER, text TEXT, file_url TEXT, file_name TEXT, timestamp INTEGER)");

    // Add admin_id column to existing conversations table (ignores error if it already exists)
    db.run("ALTER TABLE conversations ADD COLUMN admin_id INTEGER", function(err) {});
    db.run("ALTER TABLE participants ADD COLUMN last_read_timestamp INTEGER DEFAULT 0", function(err) {});
});

// ==========================================
// EXISTING ENDPOINTS (Auth & Logs)
// ==========================================
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    db.run("INSERT INTO users (username, password) VALUES (?, ?)", [username, password], function(err) {
        if (err) return res.status(400).json({ error: "Username exists" });
        res.json({ id: this.lastID, username });
    });
});

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT id, username FROM users WHERE username = ? AND password = ?", [username, password], (err, user) => {
        if (!user) return res.status(401).json({ error: "Invalid credentials" });
        res.json(user);
    });
});

app.get('/api/logs', (req, res) => {
    const userId = req.headers['x-user-id'];
    db.all("SELECT * FROM logs WHERE user_id = ? ORDER BY timestamp DESC", [userId], (err, rows) => res.json(rows || []));
});

app.post('/api/logs', (req, res) => {
    const userId = req.headers['x-user-id'];
    const { text, date, time, timestamp } = req.body;
    db.run("INSERT INTO logs (user_id, text, date, time, timestamp) VALUES (?, ?, ?, ?, ?)", [userId, text, date, time, timestamp], function(err) {
        res.json({ id: this.lastID, text, date, time, timestamp });
    });
});

app.put('/api/logs/:id', (req, res) => {
    const userId = req.headers['x-user-id'];
    db.run("UPDATE logs SET text = ? WHERE id = ? AND user_id = ?", [req.body.text, req.params.id, userId], function(err) { res.json({ success: true }); });
});

app.delete('/api/logs/:id', (req, res) => {
    const userId = req.headers['x-user-id'];
    db.run("DELETE FROM logs WHERE id = ? AND user_id = ?", [req.params.id, userId], function(err) { res.json({ success: true }); });
});

// ==========================================
// NEW ENDPOINTS (Chat & Files)
// ==========================================

// Get all users (for creating chats)
app.get('/api/users', (req, res) => {
    db.all("SELECT id, username FROM users", [], (err, rows) => res.json(rows || []));
});

// Get user's conversations (Now calculates unread messages)
app.get('/api/conversations', (req, res) => {
    const userId = req.headers['x-user-id'];
    const query = `
        SELECT c.id, c.is_group, c.name, c.admin_id,
        (SELECT username FROM users u JOIN participants p2 ON u.id = p2.user_id WHERE p2.conversation_id = c.id AND u.id != ? LIMIT 1) as other_user,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.timestamp > p.last_read_timestamp AND m.sender_id != ?) as unread_count
        FROM conversations c
        JOIN participants p ON c.id = p.conversation_id
        WHERE p.user_id = ?
    `;
    db.all(query, [userId, userId, userId], (err, rows) => res.json(rows || []));
});

// Create a new conversation (Now prevents duplicate 1-on-1 chats)
app.post('/api/conversations', (req, res) => {
    const userId = req.headers['x-user-id'];
    const { is_group, name, participant_ids } = req.body; 
    const admin_id = is_group ? userId : null; // Set admin only for groups

    const createChat = () => {
        db.run("INSERT INTO conversations (is_group, name, admin_id) VALUES (?, ?, ?)", [is_group, name, admin_id], function(err) {
            const convId = this.lastID;
            const stmt = db.prepare("INSERT INTO participants (conversation_id, user_id) VALUES (?, ?)");
            participant_ids.forEach(id => stmt.run(convId, id));
            stmt.finalize();
            res.json({ id: convId, is_group, name, admin_id });
        });
    };

    // If it's a 1-on-1 chat, check if it already exists
    if (!is_group && participant_ids.length === 2) {
        const [u1, u2] = participant_ids;
        const checkQuery = `
            SELECT c.id 
            FROM conversations c
            JOIN participants p1 ON c.id = p1.conversation_id
            JOIN participants p2 ON c.id = p2.conversation_id
            WHERE c.is_group = 0 AND p1.user_id = ? AND p2.user_id = ?
        `;
        db.get(checkQuery, [u1, u2], (err, row) => {
            if (row) {
                // Chat already exists, return the existing ID
                return res.json({ id: row.id, exists: true });
            }
            createChat();
        });
    } else {
        // It's a group chat, create it normally (duplicate groups are allowed)
        createChat();
    }
});

// Get messages for a conversation
app.get('/api/messages/:conversationId', (req, res) => {
    const query = `
        SELECT m.*, COALESCE(u.username, 'Deleted User') as username 
        FROM messages m 
        LEFT JOIN users u ON m.sender_id = u.id 
        WHERE m.conversation_id = ? 
        ORDER BY m.timestamp ASC
    `;
    db.all(query, [req.params.conversationId], (err, rows) => res.json(rows || []));
});

// Mark a conversation as read
app.post('/api/conversations/:id/read', (req, res) => {
    const userId = req.headers['x-user-id'];
    const convId = req.params.id;
    db.run("UPDATE participants SET last_read_timestamp = ? WHERE conversation_id = ? AND user_id = ?", [Date.now(), convId, userId], function(err) {
        res.json({ success: true });
    });
});

// Update User Account
app.put('/api/users', (req, res) => {
    const userId = req.headers['x-user-id'];
    const { username, password } = req.body;
    
    // Check if the new username is already taken by someone else
    db.get("SELECT id FROM users WHERE username = ? AND id != ?", [username, userId], (err, row) => {
        if (row) return res.status(400).json({ error: "Username already taken" });
        
        db.run("UPDATE users SET username = ?, password = ? WHERE id = ?", [username, password, userId], function(err) {
            res.json({ success: true });
        });
    });
});

// Delete User Account
app.delete('/api/users', (req, res) => {
    const userId = req.headers['x-user-id'];
    db.serialize(() => {
        db.run("DELETE FROM users WHERE id = ?", [userId]);
        db.run("DELETE FROM logs WHERE user_id = ?", [userId]);
        db.run("DELETE FROM participants WHERE user_id = ?", [userId]);
        // Note: We intentionally DO NOT delete from `messages` so chat history isn't ruined for others.
        res.json({ success: true });
    });
});

// Leave a Group
app.post('/api/conversations/:id/leave', (req, res) => {
    const userId = req.headers['x-user-id'];
    const convId = req.params.id;
    db.run("DELETE FROM participants WHERE conversation_id = ? AND user_id = ?", [convId, userId], function(err) {
        // If no one is left in the group, delete it entirely to save space
        db.get("SELECT COUNT(*) as count FROM participants WHERE conversation_id = ?", [convId], (err, row) => {
            if (row && row.count === 0) {
                db.run("DELETE FROM conversations WHERE id = ?", [convId]);
                db.run("DELETE FROM messages WHERE conversation_id = ?", [convId]);
            }
        });
        res.json({ success: true });
    });
});

// Delete a Chat/Group entirely (Now checks for admin rights)
app.delete('/api/conversations/:id', (req, res) => {
    const userId = req.headers['x-user-id'];
    const convId = req.params.id;

    db.get("SELECT is_group, admin_id FROM conversations WHERE id = ?", [convId], (err, row) => {
        if (!row) return res.status(404).json({ error: "Not found" });

        // If it's a group, ONLY the admin can delete it
        if (row.is_group && row.admin_id != userId) {
            return res.status(403).json({ error: "Only the group admin can delete this group." });
        }

        db.serialize(() => {
            db.run("DELETE FROM conversations WHERE id = ?", [convId]);
            db.run("DELETE FROM participants WHERE conversation_id = ?", [convId]);
            db.run("DELETE FROM messages WHERE conversation_id = ?", [convId]);
            res.json({ success: true });
        });
    });
});

// Upload a file
app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });
    res.json({ 
        file_url: `/uploads/${req.file.filename}`, 
        file_name: req.file.originalname 
    });
});

// ==========================================
// SOCKET.IO (Real-Time Chat)
// ==========================================
io.on('connection', (socket) => {
    // User joins their personal room to receive notifications
    socket.on('register', (userId) => {
        socket.join(`user_${userId}`);
    });

    // User joins a specific conversation room
    socket.on('join_conversation', (conversationId) => {
        socket.join(`conv_${conversationId}`);
    });

    // Handle sending a message
    socket.on('send_message', (data) => {
        const { conversation_id, sender_id, text, file_url, file_name, timestamp } = data;
        
        db.run(
            "INSERT INTO messages (conversation_id, sender_id, text, file_url, file_name, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
            [conversation_id, sender_id, text, file_url, file_name, timestamp],
            function(err) {
                const msgId = this.lastID;
                
                // Get sender username to attach to the broadcast
                db.get("SELECT username FROM users WHERE id = ?", [sender_id], (err, user) => {
                    const fullMessage = {
                        id: msgId, conversation_id, sender_id, text, file_url, file_name, timestamp, username: user.username
                    };
                    
                    // Broadcast to everyone currently looking at this conversation
                    io.to(`conv_${conversation_id}`).emit('receive_message', fullMessage);
                    
                    // Also notify all participants so their sidebar updates (even if they aren't in the room)
                    db.all("SELECT user_id FROM participants WHERE conversation_id = ?", [conversation_id], (err, rows) => {
                        rows.forEach(row => {
                            io.to(`user_${row.user_id}`).emit('new_message_notification', fullMessage);
                        });
                    });
                });
            }
        );
    });

    socket.on('chat_deleted', (convId) => {
        io.emit('chat_deleted_notification', convId); // Tell everyone to refresh their lists
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
});