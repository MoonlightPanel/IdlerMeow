const express = require("express");
const fs = require("fs");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const http = require("http");
const WebSocket = require("ws");
const { spawn } = require("child_process");
const archiver = require("archiver");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = 3000;

const runningServers = new Map();
const serverClients = new Map();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.set("view engine", "ejs");

app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: true
}));

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const port = req.params.port;
        const uploadPath = req.body.path || '.';
        const serverDir = path.join(__dirname, 'server_files', port.toString());
        const finalPath = path.join(serverDir, uploadPath);
        
        if (!fs.existsSync(finalPath) || !finalPath.startsWith(serverDir)) {
            return cb(new Error('Invalid upload path'), null);
        }
        cb(null, finalPath);
    },
    filename: function (req, file, cb) {
        cb(null, file.originalname);
    }
});
const upload = multer({ storage: storage });

function isTextFile(filePath) {
    const textExtensions = ['.txt', '.log', '.json', '.properties', '.yml', '.yaml', '.js', '.css', '.html', '.ejs', '.xml'];
    const ext = path.extname(filePath).toLowerCase();
    return textExtensions.includes(ext);
}

function loadAllUsers() {
    const usersDir = path.join(__dirname, "users");
    if (!fs.existsSync(usersDir)) return [];
    const files = fs.readdirSync(usersDir);
    return files.map(f => JSON.parse(fs.readFileSync(path.join(usersDir, f))));
}

function loadSettings() {
  const file = path.join(__dirname, "settings.json");
  if (!fs.existsSync(file)) {
    const defaultSettings = {
      title: "Admin Panel",
      backgroundColor: "#f5f5f5",
      backgroundImage: ""
    };
    saveSettings(defaultSettings);
    return defaultSettings;
  }
  return JSON.parse(fs.readFileSync(file));
}

function saveSettings(settings) {
  const file = path.join(__dirname, "settings.json");
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

function loadUser(username) {
  const file = path.join(__dirname, "users", `${username}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file));
}

function saveUser(user) {
  const dir = path.join(__dirname, "users");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, `${user.username}.json`);
  fs.writeFileSync(file, JSON.stringify(user, null, 2));
}

function loadServers() {
  const dir = path.join(__dirname, "servers");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const files = fs.readdirSync(dir);
  return files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f)));
      } catch (e) {
        console.error(`Failed to parse server config: ${f}`, e);
        return null;
      }
  }).filter(s => s !== null);
}

function saveServer(server) {
  const dir = path.join(__dirname, "servers");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  const file = path.join(dir, `${server.port}.json`);
  fs.writeFileSync(file, JSON.stringify(server, null, 2));
}

async function downloadPaperJar(serverDir) {
  return new Promise((resolve, reject) => {
    const jarPath = path.join(serverDir, 'server.jar');
    if (fs.existsSync(jarPath)) {
      return resolve();
    }
    
    const https = require('https');
    const url = 'https://api.papermc.io/v2/projects/paper/versions/1.20.1/builds/101/downloads/paper-1.20.1-101.jar';
    const file = fs.createWriteStream(jarPath);
    
    https.get(url, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        resolve();
      });
      file.on('error', (err) => {
        fs.unlink(jarPath, () => {}); // Delete the file on error
        reject(err);
      });
    }).on('error', (err) => {
      reject(err);
    });
  });
}

function createServerDirectory(port) {
  const serverDir = path.join(__dirname, "server_files", port.toString());
  if (!fs.existsSync(serverDir)) {
    fs.mkdirSync(serverDir, { recursive: true });
  }
  return serverDir;
}

function getServerStatus(port) {
  return runningServers.has(port) ? 'Online' : 'Offline';
}

function startMinecraftServer(port, clients) {
    if (runningServers.has(port)) {
        return { success: false, message: 'Server is already running' };
    }

    const serverDir = createServerDirectory(port);
    const servers = loadServers();
    const serverConfig = servers.find(s => s.port === port);

    if (!serverConfig) {
        const message = `[Server] Configuration for port ${port} not found.`;
        clients.forEach(ws => ws.send(JSON.stringify({ type: 'console', message, isError: true })));
        return { success: false, message: 'Server configuration not found.' };
    }
    
    if (!serverConfig.startupCommand) {
        serverConfig.startupCommand = 'java -Xms1G -Xmx1G -jar server.jar nogui';
        saveServer(serverConfig);
    }

    const eulaPath = path.join(serverDir, 'eula.txt');
    if (!fs.existsSync(eulaPath)) {
        fs.writeFileSync(eulaPath, 'eula=true\n');
    }

    // Check and update server-port in server.properties
    const propertiesPath = path.join(serverDir, 'server.properties');
    if (fs.existsSync(propertiesPath)) {
        try {
            let propertiesContent = fs.readFileSync(propertiesPath, 'utf8');
            const lines = propertiesContent.split('\n');
            let portLineFound = false;
            
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('server-port=')) {
                    const currentPort = lines[i].split('=')[1];
                    if (currentPort != port) {
                        lines[i] = `server-port=${port}`;
                        const message = `[Server] Updated server-port from ${currentPort} to ${port} in server.properties`;
                        clients.forEach(ws => ws.send(JSON.stringify({ type: 'console', message })));
                    }
                    portLineFound = true;
                    break;
                }
            }
            
            // If server-port line not found, add it
            if (!portLineFound) {
                lines.push(`server-port=${port}`);
                const message = `[Server] Added server-port=${port} to server.properties`;
                clients.forEach(ws => ws.send(JSON.stringify({ type: 'console', message })));
            }
            
            fs.writeFileSync(propertiesPath, lines.join('\n'));
        } catch (error) {
            const message = `[Server] Failed to update server.properties: ${error.message}`;
            clients.forEach(ws => ws.send(JSON.stringify({ type: 'console', message })));
        }
    }
    
    const commandParts = serverConfig.startupCommand.split(' ').filter(p => p.length > 0);
    const command = commandParts[0];
    const args = commandParts.slice(1);

    const serverProcess = spawn(command, args, { cwd: serverDir });

    serverProcess.on('error', (err) => {
        const message = `[ERROR] Failed to start server process: ${err.message}. Check if Java is installed and in your PATH.`;
        clients.forEach(ws => ws.send(JSON.stringify({ type: 'console', message })));
        runningServers.delete(port);
        clients.forEach(ws => ws.send(JSON.stringify({ type: 'status', status: 'Offline' })));
    });

    runningServers.set(port, serverProcess);

    const broadcast = (message) => {
        clients.forEach(ws => ws.send(JSON.stringify({ type: 'console', message })));
    };

    serverProcess.stdout.on('data', (data) => broadcast(data.toString()));
    serverProcess.stderr.on('data', (data) => broadcast(`[ERROR] ${data.toString()}`));

    serverProcess.on('close', (code) => {
        runningServers.delete(port);
        const message = `[Server] Server stopped with exit code ${code}.`;
        clients.forEach(ws => {
            ws.send(JSON.stringify({ type: 'console', message }));
            ws.send(JSON.stringify({ type: 'status', status: 'Offline' }));
        });
    });

    return { success: true, message: 'Server starting...' };
}

function stopMinecraftServer(port, clients) {
    const serverProcess = runningServers.get(port);
    if (!serverProcess) {
        return { success: false, message: 'Server is not running' };
    }

    serverProcess.stdin.write('stop\n');
    
    const killTimeout = setTimeout(() => {
        if (runningServers.has(port)) {
            const message = '[Server] Graceful shutdown timed out. Forcing termination.';
            clients.forEach(ws => ws.send(JSON.stringify({ type: 'console', message })));
            serverProcess.kill('SIGKILL');
        }
    }, 10000);

    serverProcess.on('close', () => {
        clearTimeout(killTimeout);
    });

    return { success: true, message: 'Stopping server...' };
}

function sendServerCommand(port, command) {
    const serverProcess = runningServers.get(port);
    if (!serverProcess) {
        return { success: false, error: 'Server is not running' };
    }
    serverProcess.stdin.write(command + '\n');
    return { success: true, message: 'Command sent' };
}

wss.on('connection', (ws, req) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathParts = url.pathname.split('/');
    if (pathParts[1] === 'ws' && pathParts[2] === 'server') {
        const port = parseInt(pathParts[3]);
        if (!serverClients.has(port)) {
            serverClients.set(port, new Set());
        }
        serverClients.get(port).add(ws);
        ws.send(JSON.stringify({ type: 'status', status: getServerStatus(port) }));
        ws.on('close', () => {
            if (serverClients.has(port)) {
                serverClients.get(port).delete(ws);
            }
        });
    }
});

function requireLogin(req, res, next) {
    if (!req.session.user) return res.redirect("/login");
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user || !req.session.user.admin) return res.status(403).send("Access Denied");
    next();
}

// --- Main Routes ---
app.get("/", (req, res) => res.redirect(req.session.user ? "/index" : "/login"));

app.get("/register", (req, res) => res.render("register"));
app.post("/register", (req, res) => {
    const { username, email, password } = req.body;
    if (loadUser(username)) return res.send("User already exists");
    const user = { username, email, password, admin: false, servers: [] };
    saveUser(user);
    req.session.user = user;
    res.redirect("/index");
});

app.get("/login", (req, res) => res.render("login"));
app.post("/login", (req, res) => {
    const { username, password } = req.body;
    const user = loadUser(username);
    if (!user || user.password !== password) return res.send("Invalid credentials");
    req.session.user = user;
    res.redirect("/index");
});

app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/login"));
});

app.get("/index", requireLogin, (req, res) => {
    const allServers = loadServers();
    let userServers;
    
    if (req.session.user.admin) {
        // Admin can see all servers
        userServers = allServers;
    } else {
        // Regular users only see their own servers
        userServers = allServers.filter(s => 
            s.owner === req.session.user.email || 
            s.user === req.session.user.email || // Backward compatibility
            (s.users && s.users.includes(req.session.user.email))
        );
    }
    const settings = loadSettings();
    res.render("index", { user: req.session.user, servers: userServers, settings });
});

app.get("/server/:port", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const server = loadServers().find(s => s.port === port);
    if (!server || (server.owner !== req.session.user.email && !req.session.user.admin && !(server.users && server.users.includes(req.session.user.email)))) {
        return res.status(403).send("Access denied");
    }
    const settings = loadSettings();
    res.render("server_detail", { server, user: req.session.user, settings });
});

// --- Server Users Page ---
app.get("/server/:port/users", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const server = loadServers().find(s => s.port === port);
    
    if (!server || (server.owner !== req.session.user.email && !req.session.user.admin)) {
        return res.status(403).send("Access Denied. Only the server owner or an admin can manage settings.");
    }

    // Ensure server.users is an array for backward compatibility
    if (!server.users) {
        server.users = [];
    }

    const allUsers = loadAllUsers();
    const settings = loadSettings();
    res.render("server_users", { server, user: req.session.user, allUsers, settings });
});

app.get("/server/:port/files", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const server = loadServers().find(s => s.port === port);
    if (!server || (server.owner !== req.session.user.email && !req.session.user.admin && !(server.users && server.users.includes(req.session.user.email)))) {
        return res.status(403).send("Access denied");
    }
    
    const serverDir = path.join(__dirname, "server_files", port.toString());
    const reqPath = req.query.path ? path.normalize(req.query.path) : '.';
    const requestedPath = path.join(serverDir, reqPath);

    if (!requestedPath.startsWith(serverDir) || !fs.existsSync(requestedPath)) {
        return res.status(404).send("File or directory not found");
    }

    const stat = fs.statSync(requestedPath);
    if (stat.isFile()) {
        if (isTextFile(requestedPath)) {
            return res.redirect(`/server/${port}/files/edit?path=${encodeURIComponent(reqPath)}`);
        } else {
            return res.download(requestedPath);
        }
    } 
    
    const files = fs.readdirSync(requestedPath).map(f => {
        const filePath = path.join(requestedPath, f);
        const fileStat = fs.statSync(filePath);
        return {
            name: f,
            path: path.join(reqPath, f).split(path.sep).join('/'),
            isDirectory: fileStat.isDirectory(),
            size: fileStat.size
        };
    }).sort((a,b) => (a.isDirectory === b.isDirectory) ? a.name.localeCompare(b.name) : (a.isDirectory ? -1 : 1) );
    
    const settings = loadSettings();
    res.render("server_files", { server, files, currentPath: reqPath, user: req.session.user, settings });
});

app.get("/server/:port/files/edit", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const server = loadServers().find(s => s.port === port);
    if (!server || (server.owner !== req.session.user.email && !req.session.user.admin && !(server.users && server.users.includes(req.session.user.email)))) {
        return res.status(403).send("Access denied");
    }

    const serverDir = path.join(__dirname, "server_files", port.toString());
    const filePath = req.query.path ? path.normalize(req.query.path) : '.';
    const requestedPath = path.join(serverDir, filePath);

    if (!requestedPath.startsWith(serverDir) || !fs.existsSync(requestedPath) || !isTextFile(requestedPath)) {
        return res.status(404).send("File not found or not a text file");
    }

    fs.readFile(requestedPath, 'utf8', (err, content) => {
        if (err) {
            return res.status(500).send("Error reading file");
        }
        const settings = loadSettings();
        const currentPath = path.dirname(filePath);
        res.render("server_file_edit", { server, filePath, content, currentPath, user: req.session.user, settings });
    });
});

// --- Admin Routes ---
app.get("/admin", requireAdmin, (req, res) => {
  const servers = loadServers();
  const users = fs.readdirSync(path.join(__dirname, "users")).map(f => JSON.parse(fs.readFileSync(path.join(__dirname, "users", f))));
  const settings = loadSettings();
  res.render("admin", { servers, users, settings });
});

// Legacy routes for backward compatibility
app.get("/admin/users", requireAdmin, (req, res) => {
  res.redirect("/admin");
});

app.get("/admin/servers", requireAdmin, (req, res) => {
  res.redirect("/admin");
});

app.post("/admin/users/create", requireAdmin, (req, res) => {
  const { username, email, password, admin } = req.body;
  if (loadUser(username)) {
    return res.redirect("/admin?error=User already exists");
  }
  const user = { username, email, password, admin: admin === "true" };
  saveUser(user);
  res.redirect("/admin");
});

app.post("/admin/users/update", requireAdmin, (req, res) => {
  const { username, email, password, admin } = req.body;
  const user = { username, email, password, admin: admin === "true" };
  saveUser(user);
  res.redirect("/admin");
});

app.post("/admin/users/delete", requireAdmin, (req, res) => {
  const { username } = req.body;
  const userFile = path.join(__dirname, "users", `${username}.json`);
  if (fs.existsSync(userFile)) {
    fs.unlinkSync(userFile);
    res.json({ success: true, message: "User deleted successfully" });
  } else {
    res.json({ success: false, message: "User not found" });
  }
});

app.post("/admin/servers/create", requireAdmin, async (req, res) => {
  const { cpu, ram, disk, userEmail, port } = req.body;
  const server = { 
      cpu, 
      ram, 
      disk, 
      owner: userEmail, // Correctly assign owner
      users: [], 
      port: parseInt(port),
      startupCommand: 'java -Xms1G -Xmx1G -jar server.jar nogui'
  };
  saveServer(server);
  try {
    const serverDir = createServerDirectory(port);
    await downloadPaperJar(serverDir);
  } catch (error) {
    console.error(`Failed to download Paper jar for port ${port}:`, error);
  }
  res.redirect("/admin");
});

app.post("/admin/settings/update", requireAdmin, (req, res) => {
  const { title, backgroundColor, backgroundImage } = req.body;
  const settings = { title, backgroundColor, backgroundImage };
  saveSettings(settings);
  res.redirect("/admin");
});

// --- API Endpoints ---
app.get("/api/server/:port/status", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    res.json({ status: getServerStatus(port) });
});

app.post("/api/server/:port/start", requireLogin, (req, res) => {
  const result = startMinecraftServer(parseInt(req.params.port), serverClients.get(parseInt(req.params.port)) || new Set());
  res.json(result);
});

app.post("/api/server/:port/stop", requireLogin, (req, res) => {
  const result = stopMinecraftServer(parseInt(req.params.port), serverClients.get(parseInt(req.params.port)) || new Set());
  res.json(result);
});

app.post("/api/server/:port/restart", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const clients = serverClients.get(port) || new Set();
    stopMinecraftServer(port, clients);
    setTimeout(() => startMinecraftServer(port, clients), 5000); // Increased delay
    res.json({ success: true, message: 'Restarting server...' });
});

app.post("/api/server/:port/command", requireLogin, (req, res) => {
  const result = sendServerCommand(parseInt(req.params.port), req.body.command);
  res.json(result);
});

// --- API for User Management ---
app.post("/api/server/:port/users/add", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const { email } = req.body;
    const servers = loadServers();
    const serverIndex = servers.findIndex(s => s.port === port);

    if (serverIndex === -1) return res.status(404).json({ success: false, message: "Server not found" });
    
    const server = servers[serverIndex];
    if (server.owner !== req.session.user.email && !req.session.user.admin) {
        return res.status(403).json({ success: false, message: "Access denied" });
    }

    if (!server.users) server.users = [];
    if (!server.users.includes(email)) {
        server.users.push(email);
    }

    saveServer(server);
    res.json({ success: true, message: "User added successfully!" });
});

app.post("/api/server/:port/users/remove", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const { email } = req.body;
    const servers = loadServers();
    const serverIndex = servers.findIndex(s => s.port === port);

    if (serverIndex === -1) return res.status(404).json({ success: false, message: "Server not found" });

    const server = servers[serverIndex];
    if (server.owner !== req.session.user.email && !req.session.user.admin) {
        return res.status(403).json({ success: false, message: "Access denied" });
    }

    server.users = server.users.filter(u => u !== email);
    saveServer(server);
    res.json({ success: true, message: "User removed successfully!" });
});

// File Management APIs...
app.post("/api/server/:port/files/upload", requireLogin, upload.array('files'), (req, res) => {
    res.json({ success: true, message: 'Files uploaded successfully' });
});

app.post("/api/server/:port/files/create-file", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const { path: reqPath, name } = req.body;
    const serverDir = path.join(__dirname, "server_files", port.toString());
    const fullPath = path.join(serverDir, reqPath, name);

    if (!fullPath.startsWith(serverDir)) {
        return res.status(400).json({ success: false, message: "Invalid path" });
    }

    fs.writeFile(fullPath, '', (err) => {
        if (err) return res.status(500).json({ success: false, message: "Failed to create file" });
        res.json({ success: true, message: "File created" });
    });
});

app.post("/api/server/:port/files/create-folder", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const { path: reqPath, name } = req.body;
    const serverDir = path.join(__dirname, "server_files", port.toString());
    const fullPath = path.join(serverDir, reqPath, name);

    if (!fullPath.startsWith(serverDir)) {
        return res.status(400).json({ success: false, message: "Invalid path" });
    }

    fs.mkdir(fullPath, { recursive: true }, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Failed to create folder" });
        res.json({ success: true, message: "Folder created" });
    });
});

app.post("/api/server/:port/files/save", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const { path: filePath, content } = req.body;
    const serverDir = path.join(__dirname, "server_files", port.toString());
    const fullPath = path.join(serverDir, filePath);

    if (!fullPath.startsWith(serverDir)) {
        return res.status(400).json({ success: false, message: "Invalid path" });
    }

    fs.writeFile(fullPath, content, 'utf8', (err) => {
        if (err) return res.status(500).json({ success: false, message: "Failed to save file" });
        res.json({ success: true, message: "File saved" });
    });
});

app.post("/api/server/:port/files/rename", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const { oldPath, newName } = req.body;
    const serverDir = path.join(__dirname, "server_files", port.toString());
    const oldFullPath = path.join(serverDir, oldPath);
    const newFullPath = path.join(path.dirname(oldFullPath), newName);

    if (!oldFullPath.startsWith(serverDir) || !newFullPath.startsWith(serverDir)) {
        return res.status(400).json({ success: false, message: "Invalid path" });
    }

    fs.rename(oldFullPath, newFullPath, (err) => {
        if (err) return res.status(500).json({ success: false, message: "Failed to rename file" });
        res.json({ success: true, message: "File renamed successfully" });
    });
});

app.post("/api/server/:port/files/archive", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const { files, archiveName } = req.body;
    const serverDir = path.join(__dirname, "server_files", port.toString());
    const archivePath = path.join(serverDir, archiveName);

    const archive = archiver('zip', { zlib: { level: 9 } });
    const output = fs.createWriteStream(archivePath);

    output.on('close', () => {
        res.json({ success: true, message: "Files archived successfully" });
    });

    archive.on('error', (err) => {
        res.status(500).json({ success: false, message: "Failed to create archive" });
    });

    archive.pipe(output);

    files.forEach(file => {
        const filePath = path.join(serverDir, file);
        if (filePath.startsWith(serverDir) && fs.existsSync(filePath)) {
            const stat = fs.statSync(filePath);
            if (stat.isDirectory()) {
                archive.directory(filePath, file);
            } else {
                archive.file(filePath, { name: file });
            }
        }
    });

    archive.finalize();
});

app.post("/api/server/:port/files/delete", requireLogin, (req, res) => {
    const port = parseInt(req.params.port);
    const { files } = req.body;
    const serverDir = path.join(__dirname, "server_files", port.toString());

    try {
        files.forEach(file => {
            const filePath = path.join(serverDir, file);
            if (filePath.startsWith(serverDir) && fs.existsSync(filePath)) {
                const stat = fs.statSync(filePath);
                if (stat.isDirectory()) {
                    fs.rmSync(filePath, { recursive: true });
                } else {
                    fs.unlinkSync(filePath);
                }
            }
        });
        res.json({ success: true, message: "Files deleted successfully" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Failed to delete files" });
    }
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
