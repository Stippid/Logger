const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname)); 

const db = new sqlite3.Database('./logs.db');

db.serialize(() => {
    db.run("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE, password TEXT)");
    db.run("CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, text TEXT, date TEXT, time TEXT, timestamp INTEGER)");
});

// Auth Endpoints
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

// Log Endpoints
app.get('/api/logs', (req, res) => {
    const userId = req.headers['x-user-id'];
    db.all("SELECT * FROM logs WHERE user_id = ? ORDER BY timestamp DESC", [userId], (err, rows) => {
        res.json(rows || []);
    });
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
    db.run("UPDATE logs SET text = ? WHERE id = ? AND user_id = ?", [req.body.text, req.params.id, userId], function(err) {
        res.json({ success: true });
    });
});

app.delete('/api/logs/:id', (req, res) => {
    const userId = req.headers['x-user-id'];
    db.run("DELETE FROM logs WHERE id = ? AND user_id = ?", [req.params.id, userId], function(err) {
        res.json({ success: true });
    });
});

const PORT = 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${PORT}`);
});