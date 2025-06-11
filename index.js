const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const url = require('url');
const querystring = require('querystring');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const TelegramBot = require('node-telegram-bot-api');

const PORT = 3000;
const TELEGRAM_BOT_TOKEN = '8138777504:AAFkTFoi6Wl1YyCocT25lsdgUhX42zDywBI'; 

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

// Initialize Telegram bot with polling
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Store Telegram chat ID to user ID mapping (in-memory for simplicity)
const telegramUserMap = new Map();
// Store login state for users awaiting password (chatId -> username)
const loginState = new Map();

// Helper function to hash passwords
function hashPassword(password) {
    return crypto.createHash('sha256').update(password).digest('hex');
}

// Helper function to get user from session (for web)
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

// Helper function to get user from Telegram chat ID
async function getUserFromChatId(chatId) {
    const userId = telegramUserMap.get(chatId);
    if (!userId) return null;

    const [userRows] = await pool.execute(
        'SELECT id, username FROM users WHERE id = ?',
        [userId]
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

// Telegram Bot Command Handlers
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 'Добро пожаловать в бот для списка дел! Используйте /login <имя_пользователя> для начала авторизации.');
});

bot.onText(/\/login (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const username = match[1].trim();

    try {
        const [rows] = await pool.execute(
            'SELECT id, username FROM users WHERE username = ?',
            [username]
        );
        if (rows.length === 0) {
            bot.sendMessage(chatId, 'Имя пользователя не найдено. Пожалуйста, сначала зарегистрируйтесь на сайте.');
            return;
        }
        // Store username in login state and prompt for password
        loginState.set(chatId, username);
        bot.sendMessage(chatId, 'Пожалуйста, отправьте ваш пароль.');
    } catch (error) {
        console.error('Ошибка в команде /login:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при входе.');
    }
});

// Handle text messages for password input
bot.on('text', async (msg) => {
    const chatId = msg.chat.id;
    // Ignore messages that are commands
    if (msg.text.startsWith('/')) return;
    // Check if user is in login state
    if (!loginState.has(chatId)) return;

    const username = loginState.get(chatId);
    const password = msg.text.trim();

    try {
        const user = await loginUser(username, password);
        if (!user) {
            bot.sendMessage(chatId, 'Неверный пароль. Попробуйте снова или используйте /login <имя_пользователя> для перезапуска.');
            return;
        }
        // Successful login: store user ID and clear login state
        telegramUserMap.set(chatId, user.id);
        loginState.delete(chatId);
        bot.sendMessage(chatId, `Успешный вход как ${user.username}! Используйте:\n/add <название дела> - для добавления дела,\n/list - для отображения списка дел,\n/delete <номер дела в списке> - для удаления дела,\n/edit <номер дела в списке> <новое название дела> - для редактирования списка дел.`);
    } catch (error) {
        console.error('Ошибка обработки пароля:', error);
        bot.sendMessage(chatId, 'Произошла ошибка при входе. Попробуйте снова или используйте /login <имя_пользователя> для перезапуска.');
        loginState.delete(chatId);
    }
});

bot.onText(/\/add (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await getUserFromChatId(chatId);
    if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, сначала войдите, используя /login <имя_пользователя>.');
        return;
    }
    const text = match[1].trim();
    if (!text) {
        bot.sendMessage(chatId, 'Пожалуйста, укажите текст для задачи, например, /add Купить продукты.');
        return;
    }
    try {
        await addListItem(text, user.id);
        bot.sendMessage(chatId, `Добавлено: "${text}" в ваш список дел.`);
    } catch (error) {
        console.error('Ошибка в команде /add:', error);
        bot.sendMessage(chatId, 'Ошибка при добавлении задачи.');
    }
});

bot.onText(/\/list/, async (msg) => {
    const chatId = msg.chat.id;
    const user = await getUserFromChatId(chatId);
    if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, сначала войдите, используя /login <имя_пользователя>.');
        return;
    }
    try {
        const items = await retrieveListItems(user.id);
        if (items.length === 0) {
            bot.sendMessage(chatId, 'Ваш список дел пуст.');
            return;
        }
        const response = items.map((item, index) => `${index + 1}. ${item.text}`).join('\n');
        bot.sendMessage(chatId, `Ваш список дел:\n${response}`);
    } catch (error) {
        console.error('Ошибка в команде /list:', error);
        bot.sendMessage(chatId, 'Ошибка при получении списка.');
    }
});

bot.onText(/\/delete (\d+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await getUserFromChatId(chatId);
    if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, сначала войдите, используя /login <имя_пользователя>.');
        return;
    }
    const index = parseInt(match[1]) - 1; // Convert to zero-based index
    try {
        const items = await retrieveListItems(user.id);
        if (index < 0 || index >= items.length) {
            bot.sendMessage(chatId, `Нет задачи с номером ${index + 1}.`);
            return;
        }
        const id = items[index].id;
        await deleteListItem(id, user.id);
        bot.sendMessage(chatId, `Удалена задача с номером ${index + 1}.`);
    } catch (error) {
        console.error('Ошибка в команде /delete:', error);
        bot.sendMessage(chatId, 'Ошибка при удалении задачи.');
    }
});

bot.onText(/\/edit (\d+) (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const user = await getUserFromChatId(chatId);
    if (!user) {
        bot.sendMessage(chatId, 'Пожалуйста, сначала войдите, используя /login <имя_пользователя>.');
        return;
    }
    const index = parseInt(match[1]) - 1; // Convert to zero-based index
    const text = match[2].trim();
    if (!text) {
        bot.sendMessage(chatId, 'Пожалуйста, укажите новый текст для задачи, например, /edit 1 Новый текст.');
        return;
    }
    try {
        const items = await retrieveListItems(user.id);
        if (index < 0 || index >= items.length) {
            bot.sendMessage(chatId, `Нет задачи с номером ${index + 1}.`);
            return;
        }
        const id = items[index].id;
        await editListItem(id, text, user.id);
        bot.sendMessage(chatId, `Обновлена задача с номером ${index + 1} на: "${text}"`);
    } catch (error) {
        console.error('Ошибка в команде /edit:', error);
        bot.sendMessage(chatId, 'Ошибка при редактировании задачи.');
    }
});

// Web Request Handler
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
    bot.stopPolling().then(() => console.log('Telegram bot polling stopped'));
    process.exit(0);
});

process.on('SIGINT', () => {
    pool.end().then(() => console.log('Pool closed'));
    bot.stopPolling().then(() => console.log('Telegram bot polling stopped'));
    process.exit(0);
});

const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));