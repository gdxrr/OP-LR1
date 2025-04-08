const http = require('http');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const url = require('url');
const querystring = require('querystring');

const PORT = 3000;

// Database connection settings
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'root',
    database: 'todolist',
};

async function retrieveListItems() {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'SELECT id, text FROM items ORDER BY id ASC'; // Order by id to maintain consistency
        const [rows] = await connection.execute(query);
        await connection.end();
        return rows;
    } catch (error) {
        console.error('Error retrieving list items:', error);
        throw error;
    }
}

async function addListItem(text) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'INSERT INTO items (text) VALUES (?)';
        const [result] = await connection.execute(query, [text]);
        await connection.end();
        return result;
    } catch (error) {
        console.error('Error adding list item:', error);
        throw error;
    }
}

async function deleteListItem(id) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'DELETE FROM items WHERE id = ?';
        const [result] = await connection.execute(query, [id]);
        await connection.end();
        return result;
    } catch (error) {
        console.error('Error deleting list item:', error);
        throw error;
    }
}

async function editListItem(id, text) {
    try {
        const connection = await mysql.createConnection(dbConfig);
        const query = 'UPDATE items SET text = ? WHERE id = ?';
        const [result] = await connection.execute(query, [text, id]);
        await connection.end();
        return result;
    } catch (error) {
        console.error('Error editing list item:', error);
        throw error;
    }
}

async function getHtmlRows(editingId = null) {
    const todoItems = await retrieveListItems();
    return todoItems.map((item, index) => {
        const displayNumber = index + 1; // Sequential number starting from 1
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

    if (req.method === 'GET' && parsedUrl.pathname === '/') {
        try {
            const html = await fs.promises.readFile(
                path.join(__dirname, 'index.html'), 
                'utf8'
            );
            const processedHtml = html.replace('{{rows}}', await getHtmlRows());
            
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(processedHtml);
        } catch (err) {
            console.error(err);
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Error loading index.html');
        }
    } else if (req.method === 'POST' && parsedUrl.pathname === '/add') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const text = postData.text?.trim();

                if (!text) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('Text is required');
                    return;
                }

                await addListItem(text);
                
                res.writeHead(302, { 'Location': '/' });
                res.end();
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error adding item');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/delete') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const id = postData.id;

                if (!id) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('ID is required');
                    return;
                }

                await deleteListItem(id);
                
                res.writeHead(302, { 'Location': '/' });
                res.end();
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error deleting item');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/edit') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });

        req.on('end', async () => {
            try {
                const postData = querystring.parse(body);
                const id = postData.id;

                if (!id) {
                    res.writeHead(400, { 'Content-Type': 'text/plain' });
                    res.end('ID is required');
                    return;
                }

                const html = await fs.promises.readFile(
                    path.join(__dirname, 'index.html'), 
                    'utf8'
                );
                const processedHtml = html.replace('{{rows}}', await getHtmlRows(id));
                
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(processedHtml);
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error entering edit mode');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/confirm') {
        let body = '';
        
        req.on('data', chunk => {
            body += chunk.toString();
        });

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

                await editListItem(id, text);
                
                res.writeHead(302, { 'Location': '/' });
                res.end();
            } catch (err) {
                console.error(err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error confirming edit');
            }
        });
    } else if (req.method === 'POST' && parsedUrl.pathname === '/cancel') {
        res.writeHead(302, { 'Location': '/' });
        res.end();
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Route not found');
    }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));