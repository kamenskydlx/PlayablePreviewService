const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const yauzl = require('yauzl');
const QRCode = require('qrcode');
const mime = require('mime-types');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Генерируем криптостойкий секрет для сессий
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex');

// Утилиты безопасности
const escapeHtml = (text) => {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
};

const isValidPath = (filePath) => {
    const normalizedPath = path.normalize(filePath);
    return !normalizedPath.includes('..') && !path.isAbsolute(normalizedPath);
};

// Создание необходимых директорий
const uploadsDir = path.join(__dirname, '../uploads');
const publicDir = path.join(__dirname, '../public');
const viewsDir = path.join(__dirname, '../views');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true });

// Утилита для чтения HTML шаблонов
const readTemplate = (templateName) => {
    return fs.readFileSync(path.join(viewsDir, templateName), 'utf8');
};

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
            fontSrc: ["'self'", "fonts.gstatic.com"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            frameSrc: ["'self'"],
            imgSrc: ["'self'", "data:"]
        }
    }
}));

// Rate limiting
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 5, // 5 попыток на IP
    message: 'Too many login attempts, try again later',
    standardHeaders: true,
    legacyHeaders: false
});

const uploadLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 минута
    max: 10, // 10 загрузок в минуту
    message: 'Too many uploads, try again later'
});

// Basic middleware
app.use(express.static(publicDir));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 часа
    }
}));

// Настройка загрузки файлов
const upload = multer({
    dest: 'temp/',
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
    fileFilter: (req, file, cb) => {
        const allowedMimes = ['text/html', 'application/zip', 'application/x-zip-compressed'];
        const allowedExts = ['.html', '.zip'];
        
        const fileExt = path.extname(file.originalname).toLowerCase();
        const isValidMime = allowedMimes.includes(file.mimetype);
        const isValidExt = allowedExts.includes(fileExt);
        
        if (isValidMime && isValidExt) {
            cb(null, true);
        } else {
            cb(new Error('Only HTML and ZIP files are allowed'), false);
        }
    }
});

// Middleware проверки авторизации
const requireAuth = (req, res, next) => {
    if (req.session.authenticated) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Утилита для определения мобильного устройства
const isMobile = (userAgent) => {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(userAgent);
};

// Утилита для безопасного извлечения ZIP
const extractZip = (zipPath, extractPath) => {
    return new Promise((resolve, reject) => {
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) return reject(err);
            
            let fileCount = 0;
            const maxFiles = 1000; // Защита от zip bombs
            
            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
                fileCount++;
                if (fileCount > maxFiles) {
                    return reject(new Error('Too many files in archive'));
                }
                
                // Защита от Path Traversal в ZIP
                if (!isValidPath(entry.fileName)) {
                    return reject(new Error('Invalid file path in archive'));
                }
                
                if (/\/$/.test(entry.fileName)) {
                    zipfile.readEntry();
                } else {
                    // Ограничиваем размер извлекаемых файлов
                    if (entry.uncompressedSize > 10 * 1024 * 1024) { // 10MB на файл
                        return reject(new Error('File too large in archive'));
                    }
                    
                    zipfile.openReadStream(entry, (err, readStream) => {
                        if (err) return reject(err);
                        
                        const safePath = path.join(extractPath, path.basename(entry.fileName));
                        const dir = path.dirname(safePath);
                        
                        if (!fs.existsSync(dir)) {
                            fs.mkdirSync(dir, { recursive: true });
                        }
                        
                        const writeStream = fs.createWriteStream(safePath);
                        readStream.pipe(writeStream);
                        writeStream.on('close', () => zipfile.readEntry());
                        writeStream.on('error', (err) => reject(err));
                    });
                }
            });
            zipfile.on('end', () => resolve());
            zipfile.on('error', (err) => reject(err));
        });
    });
};

// Утилита для поиска HTML файла
const findHtmlFile = (dir) => {
    const files = fs.readdirSync(dir, { recursive: true });
    return files.find(file => path.extname(file).toLowerCase() === '.html');
};

// Маршруты
app.get('/', (req, res) => {
    res.redirect('/admin');
});

app.get('/login', (req, res) => {
    const template = readTemplate('login.html');
    res.send(template);
});

app.post('/login', loginLimiter, (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) {
        req.session.authenticated = true;
        res.redirect('/admin');
    } else {
        res.redirect('/login?error=1');
    }
});

app.get('/admin', requireAuth, (req, res) => {
    const playables = fs.readdirSync(uploadsDir)
        .filter(item => fs.statSync(path.join(uploadsDir, item)).isDirectory())
        .map(dir => {
            const htmlFile = findHtmlFile(path.join(uploadsDir, dir));
            return { id: dir, hasHtml: !!htmlFile };
        });

    const playablesHtml = playables.map(p => {
        const safeId = escapeHtml(p.id);
        const safeUrl = escapeHtml(`${BASE_URL}/view/${p.id}`);
        return `
        <div class="playable-card">
            <div class="playable-header">
                <h3 class="playable-name">${safeId}</h3>
                <span class="status-badge ${p.hasHtml ? 'status-success' : 'status-error'}">
                    ${p.hasHtml ? 'Ready' : 'Error'}
                </span>
            </div>
            <div class="playable-link">${safeUrl}</div>
            <div class="playable-actions">
                <button class="btn btn-secondary btn-sm" onclick="copyLink('${safeUrl}')">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z"></path>
                        <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z"></path>
                    </svg>
                    Copy Link
                </button>
                <button class="btn btn-danger btn-sm" onclick="deletePlayable('${safeId}')">
                    <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd"></path>
                    </svg>
                    Delete
                </button>
            </div>
        </div>
    `;
    }).join('');

    const template = readTemplate('admin.html');
    const html = template.replace('{{PLAYABLES_CONTENT}}', playablesHtml);
    res.send(html);
});

app.post('/admin/upload', requireAuth, uploadLimiter, upload.single('playable'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).send('No file uploaded');
        }
        
        const file = req.file;
        const timestamp = Date.now();
        // Очищаем имя файла от опасных символов
        const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '').substring(0, 50);
        const playableId = `${timestamp}_${safeName.replace(/\.[^/.]+$/, "")}`;
        const playableDir = path.join(uploadsDir, playableId);
        
        fs.mkdirSync(playableDir, { recursive: true });

        if (path.extname(file.originalname).toLowerCase() === '.zip') {
            await extractZip(file.path, playableDir);
        } else {
            const safeFileName = path.basename(file.originalname);
            fs.copyFileSync(file.path, path.join(playableDir, safeFileName));
        }

        // Очищаем временный файл
        if (fs.existsSync(file.path)) {
            fs.unlinkSync(file.path);
        }
        
        res.redirect('/admin');
    } catch (error) {
        console.error('Upload error:', error);
        // Очищаем временный файл при ошибке
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        res.status(500).send(`Upload failed: ${error.message}`);
    }
});

app.delete('/admin/delete/:id', requireAuth, (req, res) => {
    try {
        const playableId = req.params.id;
        
        // Валидация ID - только безопасные символы
        if (!/^[a-zA-Z0-9._-]+$/.test(playableId)) {
            return res.status(400).json({ success: false, error: 'Invalid ID' });
        }
        
        const playableDir = path.join(uploadsDir, playableId);
        
        // Дополнительная проверка что путь находится внутри uploads
        if (!playableDir.startsWith(path.resolve(uploadsDir))) {
            return res.status(400).json({ success: false, error: 'Invalid path' });
        }
        
        if (fs.existsSync(playableDir)) {
            fs.rmSync(playableDir, { recursive: true });
        }
        
        res.json({ success: true });
    } catch (error) {
        console.error('Delete error:', error);
        res.status(500).json({ success: false, error: 'Delete failed' });
    }
});

// Конфигурация устройств
const DEVICE_PRESETS = {
    'iphone-14': { name: 'iPhone 14', width: 390, height: 844 },
    'iphone-se': { name: 'iPhone SE', width: 375, height: 667 },
    'ipad': { name: 'iPad', width: 768, height: 1024 },
    'ipad-mini': { name: 'iPad Mini', width: 744, height: 1133 },
    'galaxy-s23': { name: 'Galaxy S23', width: 360, height: 780 },
    'pixel-7': { name: 'Pixel 7', width: 412, height: 915 }
};

// Просмотр плеебла
app.get('/view/:id', (req, res) => {
    const playableId = req.params.id;
    const playableDir = path.join(uploadsDir, playableId);
    
    if (!fs.existsSync(playableDir)) {
        return res.status(404).send('Playable not found');
    }

    const htmlFile = findHtmlFile(playableDir);
    if (!htmlFile) {
        return res.status(404).send('HTML file not found in playable');
    }

    const userAgent = req.get('User-Agent') || '';
    const mobile = isMobile(userAgent);
    const device = req.query.device || 'iphone-14';
    const preset = DEVICE_PRESETS[device] || DEVICE_PRESETS['iphone-14'];

    if (mobile) {
        // Мобильная версия - полный экран
        const template = readTemplate('mobile.html');
        const html = template
            .replace('{{TITLE}}', `Playable: ${playableId}`)
            .replace('{{IFRAME_SRC}}', `/playable/${playableId}/${htmlFile}`);
        res.send(html);
    } else {
        // Десктопная версия с элементами управления
        const deviceOptions = Object.entries(DEVICE_PRESETS)
            .map(([key, preset]) => 
                `<option value="${key}" ${key === device ? 'selected' : ''}>${preset.name} (${preset.width}×${preset.height})</option>`
            ).join('');

        const desktopContent = `
            <div class="viewer-container">
                <div class="viewer-controls">
                    <div class="control-group">
                        <label class="control-label">Device:</label>
                        <select id="deviceSelect" class="device-select" onchange="changeDevice()">
                            ${deviceOptions}
                        </select>
                    </div>
                    <div class="control-group">
                        <button class="btn btn-secondary" onclick="reloadPlayable()">
                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd"></path>
                            </svg>
                            Reload
                        </button>
                        <button class="btn btn-primary" onclick="showQR()">
                            <svg width="16" height="16" fill="currentColor" viewBox="0 0 20 20">
                                <path fill-rule="evenodd" d="M3 4a1 1 0 011-1h3a1 1 0 011 1v3a1 1 0 01-1 1H4a1 1 0 01-1-1V4zm2 2V5h1v1H5zM3 13a1 1 0 011-1h3a1 1 0 011 1v3a1 1 0 01-1 1H4a1 1 0 01-1-1v-3zm2 2v-1h1v1H5zM13 3a1 1 0 00-1 1v3a1 1 0 001 1h3a1 1 0 001-1V4a1 1 0 00-1-1h-3zm1 2v1h1V5h-1z" clip-rule="evenodd"></path>
                                <path d="M11 4a1 1 0 10-2 0v1a1 1 0 002 0V4zM10 7a1 1 0 011 1v1h-1a1 1 0 01-1-1 1 1 0 00-1-1H7a1 1 0 00-1 1v1h1a1 1 0 011 1v1a1 1 0 001 1h1a1 1 0 001-1v-1a1 1 0 011-1h1a1 1 0 001-1V8a1 1 0 00-1-1h-2z"></path>
                            </svg>
                            QR Code
                        </button>
                    </div>
                </div>

                <div class="viewer-content">
                    <div>
                        <div class="device-info">${preset.name} - ${preset.width} × ${preset.height}</div>
                        <div class="device-frame">
                            <div class="device-screen" style="width: ${preset.width}px; height: ${preset.height}px;">
                                <iframe id="playableFrame" src="/playable/${playableId}/${htmlFile}"></iframe>
                            </div>
                        </div>
                    </div>
                </div>

                <div id="qrModal" class="qr-modal" onclick="closeQR()">
                    <div class="qr-content" onclick="event.stopPropagation()">
                        <h2 class="qr-title">Scan QR Code</h2>
                        <div id="qrCode"></div>
                        <p class="qr-description">Scan with your mobile device to open playable in fullscreen</p>
                        <button class="btn btn-secondary" onclick="closeQR()">Close</button>
                    </div>
                </div>
            </div>
        `;

        const template = readTemplate('viewer.html');
        const html = template
            .replace('{{TITLE}}', `Playable Preview: ${playableId}`)
            .replace('{{BODY_CLASS}}', '')
            .replace('{{CONTENT}}', desktopContent);
        res.send(html);
    }
});

// API для генерации QR кода
app.get('/api/qr', async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).send('URL required');
        
        const qr = await QRCode.toString(url, { 
            type: 'svg',
            width: 256,
            margin: 2
        });
        res.setHeader('Content-Type', 'image/svg+xml');
        res.send(qr);
    } catch (error) {
        res.status(500).send('QR generation failed');
    }
});

// Безопасный статический сервер для плееблов
app.get('/playable/:id/*', (req, res) => {
    try {
        const playableId = req.params.id;
        const filePath = req.params[0];
        
        // Валидация ID
        if (!/^[a-zA-Z0-9._-]+$/.test(playableId)) {
            return res.status(400).send('Invalid playable ID');
        }
        
        // Валидация пути к файлу
        if (!isValidPath(filePath)) {
            return res.status(400).send('Invalid file path');
        }
        
        const fullPath = path.join(uploadsDir, playableId, filePath);
        
        // Проверяем что путь находится внутри uploads
        if (!fullPath.startsWith(path.resolve(uploadsDir))) {
            return res.status(403).send('Access denied');
        }
        
        if (fs.existsSync(fullPath) && !fs.statSync(fullPath).isDirectory()) {
            const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
            
            // Дополнительная безопасность для MIME типов
            const safeMimeTypes = [
                'text/html', 'text/css', 'text/javascript', 'application/javascript',
                'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml',
                'audio/mpeg', 'audio/wav', 'video/mp4', 'video/webm',
                'application/json', 'font/woff', 'font/woff2'
            ];
            
            if (!safeMimeTypes.includes(mimeType)) {
                return res.status(403).send('File type not allowed');
            }
            
            res.setHeader('Content-Type', mimeType);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.sendFile(path.resolve(fullPath));
        } else {
            res.status(404).send('File not found');
        }
    } catch (error) {
        console.error('File serve error:', error);
        res.status(500).send('Server error');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

app.listen(PORT, () => {
    console.log(`Playable Preview Service running on port ${PORT}`);
    console.log(`Admin password: ${ADMIN_PASSWORD}`);
});