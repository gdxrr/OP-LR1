const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const PORT = 3000;

// Database connection settings
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'todolist',
};

// In-memory session store (for simplicity; use Redis or similar in production)
const sessions = {};

// Helper function to hash passwords
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Helper function to get user from session
async function getUserFromSession(req) {
    const cookies = querystring.parse(req.headers.cookie || '', '; ');
    const sessionId = cookies.sessionId;
    if (!sessionId || !sessions[sessionId]) return null;
    return sessions[sessionId];
}

// Database functions
async function retrieveListItems(userId) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'SELECT id, text FROM items WHERE user_id = ? ORDER BY id ASC';
        const [rows] = await connection.execute(query, [userId]);
        await connection.end();
        return rows;
    } catch (error) {
        console.error('Error retrieving list items:', error);
        throw error;
    }
}

async function addListItem(text, userId) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'INSERT INTO items (text, user_id) VALUES (?, ?)';
        const [result] = await connection.execute(query, [text, userId]);
        await connection.end();
        return result;
    } catch (error) {
        console.error('Error adding list item:', error);
        throw error;
    }
}

async function deleteListItem(id, userId) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'DELETE FROM items WHERE id = ? AND user_id = ?';
        const [result] = await connection.execute(query, [id, userId]);
        await connection.end();
        return result;
    } catch (error) {
        console.error('Error deleting list item:', error);
        throw error;
    }
}

async function editListItem(id, text, userId) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'UPDATE items SET text = ? WHERE id = ? AND user_id = ?';
        const [result] = await connection.execute(query, [text, id, userId]);
        await connection.end();
        return result;
    } catch (error) {
        console.error('Error editing list item:', error);
        throw error;
    }
}

async function registerUser(username, password) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const hashedPassword = hashPassword(password);
        const query = 'INSERT INTO users (username, password) VALUES (?, ?)';
        const [result] = await connection.execute(query, [username, hashedPassword]);
        await connection.end();
        return result;
    } catch (error) {
        console.error('Error registering user:', error);
        throw error;
    }
}

async function loginUser(username, password) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'SELECT id, username, password FROM users WHERE username = ?';
        const [rows] = await connection.execute(query, [username]);
        await connection.end();
        if (rows.length === 0) return null;
        const user = rows[0];
        const hashedPassword = hashPassword(password);
        if (user.password !== hashedPassword) return null;
        return { id: user.id, username: user.username };
    } catch (error) {
        console.error('Error logging in user:', error);
        throw error;
    }
}

async function getHtmlRows(userId, editingId = null) {
    const todoItems = await retrieveListItems(userId);
    return todoItems.map((item, index) => {
        const displayNumber = index + 1;
        if (editingId === item.id.toString()) {
            return `
                <tr>
                    <td>${displayNumber}</td>
                    <td>
                        <form action="/confirm" method="POST" class="confirm-form">
                            <input type="hidden" name="id" value="${item.id}">
                            <input type="text" name="text" value="${item.text}" class="edit-input">
                            <button type="submit" class="confirm-btn">✓</button>
                        </form>
                        <form action="/cancel" method="POST" class="cancel-form">
                            <input type="hidden" name="id" value="${item.id}">
                            <button type="submit" class="cancel-btn">×</button>
                        </form>
                    </td>
                    <td></td>
                </tr>
            `;
        } else {
            return `
                <tr>
                    <td>${displayNumber}</td>
                    <td>${item.text}</td>
                    <td>
                        <div class="action-buttons">
                            <form action="/edit" method="POST" class="edit-form">
                                <input type="hidden" name="id" value="${item.id}">
                                <button type="submit" class="edit-btn">✎</button>
                            </form>
                            <form action="/delete" method="POST" class="delete-form">
                                <input type="hidden" name="id" value="${item.id}">
                                <button type="submit" class="delete-btn">🗑️</button>
                            </form>
                        </div>
                    </td>
                </tr>
            `;
        }
    }).join('');
}

async function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url);
    const user = await getUserFromSession(req);

    // Load HTML template
    let html;
    try {
        html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    } catch (err) {
        console.error(err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading index.html');
        return;
    }

    // Authentication section
    let authSection = '';
    let todoSection = '';
    if (!user) {
        authSection = `
            <div class="form-container">
                <h2>Login</h2>
                <form action="/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required>
                    <input type="password" name="password" placeholder="Password" required>
                    <button type="submit">Login</button>
                </form>
                <h2>Register</h2>
                <form action="/register" method="POST">
                    <input type="text" name="username" placeholder="Username" required>
                    <input type="password" name="password" placeholder="Password" required>
                    <button type="submit">Register</button>
                </form>
            </div>
        `;
    } else {
        authSection = `
            <div class="form-container">
                <p>Welcome, ${user.username}!</p>
                <form action="/logout" method="POST">
                    <button type="submit" class="logout-btn">Logout</button>
                </form>
            </div>
        `;
        todoSection = `
            <h1>To-Do List</h1>
            <table>
                <tr>
                    <th>Number</th>
                    <th>Text</th>
                    <th>Action</th>
                </tr>
                {{rows}}
            </table>
            <div class="form-container">
                <form action="/add" method="POST">
                    <input type="text" name="text" placeholder="Add new item" required>
                    <button type="submit">Add</button>
                </form>
            </div>
        `;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/') {
        if (!user) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', ''));
            return;
        }
        try {
            const processedHtml = html
                .replace('{{auth_section}}', authSection)
                .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id)));
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(processedHtml);
        } catch (err) {
            console.error(err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading to-do list');
        }
    } else if (req.method === 'POST' && parsedUrl.pathname === '/register') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const { username, password } = postData;
                if (!username || !password) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Username and password are required');
                    return;
                }
                await registerUser(username, password);
                res.writeHead(302, { 'Location': '/' });
                res.end();
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error registering user');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/login') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const { username, password } = postData;
                if (!username || !password) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Username and password are required');
                    return;
                }
                const user = await loginUser(username, password);
                if (!user) {
                    res.writeHead(401, { 'Content-Type': 'text/plain' });
                    res.end('Invalid username or password');
                    return;
                }
                const sessionId = uuidv4();
                sessions[sessionId] = user;
                res.writeHead(302, {
                    'Location': '/',
                    'Set-Cookie': `sessionId=${sessionId}; HttpOnly; Path=/`
                });
                res.end();
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error logging in');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/logout') {
        const cookies = querystring.parse(req.headers.cookie || '', '; ');
        const sessionId = cookies.sessionId;
        if (sessionId && sessions[sessionId]) {
            delete sessions[sessionId];
        }
        res.writeHead(302, {
            'Location': '/',
            'Set-Cookie': 'sessionId=; HttpOnly; Path=/; Max-Age=0'
        });
        res.end();
    } else if (req.method === 'POST' && parsedUrl.pathname === '/add') {
        if (!user) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const text = postData.text?.trim();
                if (!text) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Text is required');
                    return;
                }
                await addListItem(text, user.id);
                res.writeHead(302, { 'Location': '/' });
                res.end();
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error adding item');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/delete') {
        if (!user) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const id = postData.id;
                if (!id) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('ID is required');
                    return;
                }
                await deleteListItem(id, user.id);
                res.writeHead(302, { 'Location': '/' });
                res.end();
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error deleting item');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/edit') {
        if (!user) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const id = postData.id;
                if (!id) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('ID is required');
                    return;
                }
                const processedHtml = html
                    .replace('{{auth_section}}', authSection)
                    .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id, id)));
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(processedHtml);
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error entering edit mode');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/confirm') {
        if (!user) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const id = postData.id;
                const text = postData.text?.trim();
                if (!id || !text) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('ID and text are required');
                    return;
                }
                await editListItem(id, text, user.id);
                res.writeHead(302, { 'Location': '/' });
                res.end();
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error confirming edit');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/cancel') {
        if (!user) {
            res.writeHead(401, { 'Content-Type': 'text/plain' });
            res.end('Unauthorized');
            return;
        }
        res.writeHead(302, { 'Location': '/' });
        res.end();
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Route not found');
    }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));