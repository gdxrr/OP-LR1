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
        const query = 'SELECT id, text FROM items';
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

async function getHtmlRows() {
    const todoItems = await retrieveListItems();
    return todoItems.map(item => `
        <tr>
            <td>${item.id}</td>
            <td>${item.text}</td>
            <td>
                <form action="/delete" method="POST" class="delete-form">
                    <input type="hidden" name="id" value="${item.id}">
                    <button type="submit" class="delete-btn">×</button>
                </form>
            </td>
        </tr>
    `).join('');
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
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Route not found');
    }
}

const server = http.createServer(handleRequest);
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));