const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const PORT = 3000;

// Database connection pool settings
const pool = mysql.createPool({
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'todolist',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

// Helper function to hash passwords
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Helper function to get user from session
async function getUserFromSession(req) {
    const cookies = querystring.parse(req.headers.cookie || '', '; ');
    const sessionId = cookies.sessionId;
    if (!sessionId) return null;

    const [rows] = await pool.execute(
        'SELECT user_id FROM sessions WHERE session_id = ? AND expires_at > NOW()',
        [sessionId]
    );
    if (rows.length === 0) return null;

    const [userRows] = await pool.execute(
        'SELECT id, username FROM users WHERE id = ?',
        [rows[0].user_id]
    );
    return userRows.length > 0 ? { id: userRows[0].id, username: userRows[0].username } : null;
}

// Database functions
async function retrieveListItems(userId) {
    try {
        const [rows] = await pool.execute(
            'SELECT id, text FROM items WHERE user_id = ? ORDER BY id ASC',
            [userId]
        );
        return rows;
    } catch (error) {
        console.error('Error retrieving list items for user', userId, ':', error);
        throw error;
    }
}

async function addListItem(text, userId) {
    try {
        const [result] = await pool.execute(
            'INSERT INTO items (text, user_id) VALUES (?, ?)',
            [text, userId]
        );
        return result;
    } catch (error) {
        console.error('Error adding list item for user', userId, ':', error);
        throw error;
    }
}

async function deleteListItem(id, userId) {
    try {
        const [result] = await pool.execute(
            'DELETE FROM items WHERE id = ? AND user_id = ?',
            [id, userId]
        );
        return result;
    } catch (error) {
        console.error('Error deleting list item for user', userId, ':', error);
        throw error;
    }
}

async function editListItem(id, text, userId) {
    try {
        const [result] = await pool.execute(
            'UPDATE items SET text = ? WHERE id = ? AND user_id = ?',
            [text, id, userId]
        );
        return result;
    } catch (error) {
        console.error('Error editing list item for user', userId, ':', error);
        throw error;
    }
}

async function registerUser(username, password) {
    try {
        const hashedPassword = hashPassword(password);
        const [result] = await pool.execute(
            'INSERT INTO users (username, password) VALUES (?, ?)',
            [username, hashedPassword]
        );
        console.log('Registration successful for:', username);
        return result;
    } catch (error) {
        console.error('Registration error for', username, ':', error);
        throw error;
    }
}

async function loginUser(username, password) {
    try {
        const [rows] = await pool.execute(
            'SELECT id, username, password FROM users WHERE username = ?',
            [username]
        );
        if (rows.length === 0) return null;
        const user = rows[0];
        const hashedPassword = hashPassword(password);
        if (user.password !== hashedPassword) return null;
        return { id: user.id, username: user.username };
    } catch (error) {
        console.error('Login error for', username, ':', error);
        throw error;
    }
}

async function createSession(userId) {
    try {
        const sessionId = uuidv4();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours expiration
        await pool.execute(
            'INSERT INTO sessions (session_id, user_id, expires_at) VALUES (?, ?, ?)',
            [sessionId, userId, expiresAt]
        );
        return sessionId;
    } catch (error) {
        console.error('Error creating session for user', userId, ':', error);
        throw error;
    }
}

async function deleteSession(sessionId) {
    try {
        await pool.execute(
            'DELETE FROM sessions WHERE session_id = ?',
            [sessionId]
        );
    } catch (error) {
        console.error('Error deleting session', sessionId, ':', error);
        throw error;
    }
}

async function getHtmlRows(userId, editingId) {
    try {
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
    } catch (error) {
        console.error('Error generating HTML rows for user', userId, ':', error);
        throw error;
    }
}

async function handleRequest(req, res) {
    const parsedUrl = url.parse(req.url);
    const user = await getUserFromSession(req);

    // Load HTML template
    let html;
    try {
        html = await fs.promises.readFile(path.join(__dirname, 'index.html'), 'utf8');
    } catch (err) {
        console.error('Error loading index.html:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error loading index.html');
        return;
    }

    // Determine if registration form should be shown
    let showRegister = false;
    if (req.method === 'GET' && parsedUrl.pathname === '/register') {
        showRegister = true;
    }

    let authSection = '';
    let todoSection = '';
    if (!user) {
        if (showRegister) {
            authSection = `
                <div class="form-container">
                    <h1>Register</h1>
                    <form action="/register" method="POST">
                        <input type="text" name="username" placeholder="Username" required>
                        <div class="password-wrapper">
                            <input type="password" id="register-password" name="password" placeholder="Password" required>
                            <span id="password-toggle" class="password-toggle" onclick="togglePasswordVisibility()">👁️‍🗨️</span>
                        </div>
                        <button type="submit" class="login-btn">Register</button>
                    </form>
                    <div class="login-link">
                        <a href="/">Log in</a>
                    </div>
                    <p class="error-message">{{error}}</p>
                </div>
            `;
        } else {
            authSection = `
                <div class="form-container">
                    <h1>Log In</h1>
                    <form action="/login" method="POST">
                        <input type="text" name="username" placeholder="Username" required>
                        <input type="password" name="password" placeholder="Password" required>
                        <button type="submit" class="login-btn">Log in</button>
                    </form>
                    <div class="register-link">
                        <a href="/register">Register</a>
                    </div>
                    <div class="login-link"></div>
                    <p class="error-message">{{error}}</p>
                </div>
            `;
        }
    } else {
        authSection = `
            <div class="form-container">
                <p>Welcome, ${user.username}!</p>
                <form action="/logout" method="POST">
                    <button type="submit" class="login-btn">Logout</button>
                </form>
            </div>
        `;
        todoSection = `
            <div class="todo-section">
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
            </div>
        `;
    }

    if (req.method === 'GET' && parsedUrl.pathname === '/') {
        if (!user) {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', '').replace('{{error}}', ''));
            return;
        }
        try {
            const processedHtml = html
                .replace('{{auth_section}}', authSection)
                .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id, null)))
                .replace('{{error}}', '');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(processedHtml);
        } catch (err) {
            console.error('Error processing GET /:', err);
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
                    authSection = authSection.replace('{{error}}', 'Username and password are required');
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', '').replace('{{error}}', ''));
                    return;
                }
                await registerUser(username, password);
                authSection = authSection.replace('{{error}}', '');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', '').replace('{{error}}', ''));
            } catch (err) {
                console.error('Error in /register route:', err);
                let errorMessage = 'An error occurred during registration';
                if (err.code === 'ER_DUP_ENTRY') {
                    errorMessage = 'Username already exists';
                }
                authSection = authSection.replace('{{error}}', errorMessage);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', '').replace('{{error}}', ''));
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
                    authSection = authSection.replace('{{error}}', 'Username and password are required');
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', '').replace('{{error}}', ''));
                    return;
                }
                const user = await loginUser(username, password);
                if (!user) {
                    authSection = authSection.replace('{{error}}', 'Invalid username or password');
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', '').replace('{{error}}', ''));
                    return;
                }
                // Successful login: create session and render authenticated view
                const sessionId = await createSession(user.id);
                authSection = `
                    <div class="form-container">
                        <p>Welcome, ${user.username}!</p>
                        <form action="/logout" method="POST">
                            <button type="submit" class="login-btn">Logout</button>
                        </form>
                    </div>
                `;
                todoSection = `
                    <div class="todo-section">
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
                    </div>
                `;
                const processedHtml = html
                    .replace('{{auth_section}}', authSection)
                    .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id, null)))
                    .replace('{{error}}', '');
                res.writeHead(200, {
                    'Content-Type': 'text/html',
                    'Set-Cookie': `sessionId=${sessionId}; HttpOnly; Path=/`
                });
                res.end(processedHtml);
            } catch (err) {
                console.error('Error in /login route:', err);
                authSection = authSection.replace('{{error}}', 'An error occurred during login');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', '').replace('{{error}}', ''));
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/logout') {
        const cookies = querystring.parse(req.headers.cookie || '', '; ');
        const sessionId = cookies.sessionId;
        if (sessionId) {
            await deleteSession(sessionId);
        }
        // Force clear the session cookie and render login page
        authSection = `
            <div class="form-container">
                <h1>Log In</h1>
                <form action="/login" method="POST">
                    <input type="text" name="username" placeholder="Username" required>
                    <input type="password" name="password" placeholder="Password" required>
                    <button type="submit" class="login-btn">Log in</button>
                </form>
                <div class="register-link">
                        <a href="/register">Register</a>
                    </div>
                <div class="login-link"></div>
                <p class="error-message">{{error}}</p>
            </div>
        `;
        const processedHtml = html
            .replace('{{auth_section}}', authSection)
            .replace('{{todo_section}}', '')
            .replace('{{error}}', '');
        res.writeHead(200, {
            'Content-Type': 'text/html',
            'Set-Cookie': 'sessionId=; HttpOnly; Path=/; Max-Age=0'
        });
        res.end(processedHtml);
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
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html
                    .replace('{{auth_section}}', authSection)
                    .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id, null)))
                    .replace('{{error}}', ''));
            } catch (err) {
                console.error('Error in /add route:', err);
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
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html
                    .replace('{{auth_section}}', authSection)
                    .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id, null)))
                    .replace('{{error}}', ''));
            } catch (err) {
                console.error('Error in /delete route:', err);
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
                    .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id, id)))
                    .replace('{{error}}', '');
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(processedHtml);
            } catch (err) {
                console.error('Error in /edit route:', err);
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
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(html
                    .replace('{{auth_section}}', authSection)
                    .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id, null)))
                    .replace('{{error}}', ''));
            } catch (err) {
                console.error('Error in /confirm route:', err);
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
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html
            .replace('{{auth_section}}', authSection)
            .replace('{{todo_section}}', todoSection.replace('{{rows}}', await getHtmlRows(user.id, null)))
            .replace('{{error}}', ''));
    } else if (req.method === 'GET' && parsedUrl.pathname === '/register') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html.replace('{{auth_section}}', authSection).replace('{{todo_section}}', '').replace('{{error}}', ''));
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Route not found');
    }
}

// Graceful shutdown to ensure pool is closed properly
process.on('SIGTERM', () => {
    pool.end().then(() => console.log('Pool closed'));
    process.exit(0);
});

process.on('SIGINT', () => {
    pool.end().then(() => console.log('Pool closed'));
    process.exit(0);
});

const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));