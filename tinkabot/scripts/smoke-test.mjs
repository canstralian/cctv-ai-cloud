import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(process.cwd());
const pluginPath = path.join(root, 'plugin.json');
const skillPath = path.join(root, 'skills', 'fetch-public-todo.md');

const plugin = JSON.parse(readFileSync(pluginPath, 'utf8'));
validatePlugin(plugin);

const skillText = readFileSync(skillPath, 'utf8');
if (!skillText.includes('mcp__tinkabot__fetch_todo')) {
  throw new Error('Skill file does not reference expected MCP tool.');
}

await runMcpSmokeTest();

console.log('✅ plugin.json shape validated');
console.log('✅ skill file validated');
console.log('✅ MCP stdio initialize/list/call validated');

function validatePlugin(value) {
  const required = ['name', 'version', 'description', 'skills', 'mcp', 'dataShapes'];
  for (const key of required) {
    if (!(key in value)) throw new Error(`plugin.json missing required key: ${key}`);
  }

  if (value.name !== 'tinkabot') throw new Error('plugin.json name must be tinkabot');
  if (value.version !== '0.1.0') throw new Error('plugin.json version must be 0.1.0');
  if (!Array.isArray(value.skills) || value.skills.length === 0) {
    throw new Error('plugin.json skills must be a non-empty array');
  }
}

async function runMcpSmokeTest() {
  const mockServer = await startMockApi();
  const baseUrl = `http://127.0.0.1:${mockServer.address().port}`;

  const child = spawn('node', ['mcp/server.mjs'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      TINKABOT_API_BASE_URL: baseUrl,
      TINKABOT_TIMEOUT_MS: '5000'
    }
  });

  const responses = [];
  let buffer = Buffer.alloc(0);

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = buffer.slice(0, headerEnd).toString('utf8');
      const line = header.split('\r\n').find((x) => x.toLowerCase().startsWith('content-length:'));
      if (!line) throw new Error('Missing Content-Length in MCP response');
      const len = Number.parseInt(line.split(':')[1].trim(), 10);
      const total = headerEnd + 4 + len;
      if (buffer.length < total) break;

      const body = buffer.slice(headerEnd + 4, total).toString('utf8');
      buffer = buffer.slice(total);
      responses.push(JSON.parse(body));
    }
  });

  const errors = [];
  child.stderr.on('data', (chunk) => errors.push(chunk.toString('utf8')));

  send(child, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  send(child, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send(child, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'fetch_todo', arguments: { id: 1 } }
  });

  await waitFor(() => responses.length >= 3, 10000, errors);

  const init = responses.find((r) => r.id === 1);
  const list = responses.find((r) => r.id === 2);
  const call = responses.find((r) => r.id === 3);

  if (!init?.result?.serverInfo?.name) throw new Error('Initialize response missing serverInfo.');
  if (!Array.isArray(list?.result?.tools) || list.result.tools.length === 0) throw new Error('tools/list returned no tools.');

  const text = call?.result?.content?.[0]?.text;
  if (!text) throw new Error('tools/call returned no text content.');

  const parsed = JSON.parse(text);
  if (!parsed.todo || parsed.todo.id !== 1) throw new Error('tools/call TODO payload invalid.');

  child.kill('SIGTERM');
  await stopMockApi(mockServer);
}

function send(child, message) {
  const body = JSON.stringify(message);
  child.stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`);
}

function waitFor(predicate, timeoutMs, errors) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (errors.length > 0) {
        clearInterval(timer);
        reject(new Error(errors.join('\n')));
        return;
      }
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for MCP responses.'));
      }
    }, 50);
  });
}

function startMockApi() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/todos/1') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ userId: 1, id: 1, title: 'mock todo', completed: false }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function stopMockApi(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
