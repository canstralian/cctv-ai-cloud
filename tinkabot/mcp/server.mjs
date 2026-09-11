import { URL } from 'node:url';

const API_BASE_URL = process.env.TINKABOT_API_BASE_URL || 'https://jsonplaceholder.typicode.com';
const TIMEOUT_MS = Number.parseInt(process.env.TINKABOT_TIMEOUT_MS || '5000', 10);

let inputBuffer = Buffer.alloc(0);

process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  consumeMessages();
});

function consumeMessages() {
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const headerText = inputBuffer.slice(0, headerEnd).toString('utf8');
    const contentLengthHeader = headerText
      .split('\r\n')
      .find((line) => line.toLowerCase().startsWith('content-length:'));

    if (!contentLengthHeader) {
      inputBuffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number.parseInt(contentLengthHeader.split(':')[1].trim(), 10);
    const totalLength = headerEnd + 4 + contentLength;
    if (inputBuffer.length < totalLength) return;

    const body = inputBuffer.slice(headerEnd + 4, totalLength).toString('utf8');
    inputBuffer = inputBuffer.slice(totalLength);

    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }

    handleMessage(message).catch((error) => {
      sendMessage({
        jsonrpc: '2.0',
        id: message?.id ?? null,
        error: {
          code: -32603,
          message: `Internal error: ${error.message}`
        }
      });
    });
  }
}

function sendMessage(payload) {
  const json = JSON.stringify(payload);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
}

async function handleMessage(message) {
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    return;
  }

  if (message.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'tinkabot', version: '0.1.0' },
        capabilities: { tools: {} }
      }
    });
    return;
  }

  if (message.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        tools: [
          {
            name: 'fetch_todo',
            description: 'Fetch a TODO by id from JSONPlaceholder.',
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'integer', minimum: 1, maximum: 200 }
              },
              required: ['id'],
              additionalProperties: false
            }
          }
        ]
      }
    });
    return;
  }

  if (message.method === 'tools/call') {
    const name = message.params?.name;
    if (name !== 'fetch_todo') {
      sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unknown tool: ${name}` }
      });
      return;
    }

    const id = message.params?.arguments?.id;
    if (!Number.isInteger(id) || id < 1 || id > 200) {
      sendMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: 'Invalid arguments: id must be an integer between 1 and 200.' }
      });
      return;
    }

    const result = await fetchTodo(id);
    sendMessage({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result)
          }
        ]
      }
    });
    return;
  }

  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    sendMessage({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` }
    });
  }
}

async function fetchTodo(id) {
  const url = new URL(`/todos/${id}`, API_BASE_URL).toString();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Upstream API returned ${response.status}.`);
    }

    const parsed = await response.json().catch(() => {
      throw new Error('Upstream API returned malformed JSON.');
    });

    if (!isTodo(parsed)) {
      throw new Error('Upstream API response missing required TODO fields.');
    }

    return {
      integration: {
        name: 'jsonplaceholder',
        kind: 'http_api',
        baseUrl: API_BASE_URL,
        auth: 'none'
      },
      todo: parsed,
      fetchedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`Request timeout after ${TIMEOUT_MS}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function isTodo(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isInteger(value.userId) &&
    Number.isInteger(value.id) &&
    typeof value.title === 'string' &&
    typeof value.completed === 'boolean'
  );
}
