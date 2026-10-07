// socket.mjs — probe if the Blender MCP socket server is listening on localhost:9876.
import net from 'node:net';

const host = process.env.BLENDER_HOST || '127.0.0.1';
const port = parseInt(process.env.BLENDER_PORT || '9876', 10);

const socket = new net.Socket();
let done = false;

const finish = (result) => {
  if (done) return;
  done = true;
  socket.destroy();
  console.log(JSON.stringify(result));
  process.exit(0);
};

socket.setTimeout(800);

socket.connect(port, host, () => {
  finish({
    status: 'pass',
    detail: `Blender MCP server reachable at ${host}:${port}`,
  });
});

socket.on('error', (err) => {
  finish({
    status: 'warn',
    detail: `Blender MCP socket not listening on ${host}:${port} (${err.code || err.message}). Open Blender and click "Start MCP Server" in the MCP tab (N panel).`,
    fix: {
      description: 'Launch Blender, press N to open the sidebar, select MCP for Blender, and click "Start MCP Server".',
    },
  });
});

socket.on('timeout', () => {
  finish({
    status: 'warn',
    detail: `Connection timed out connecting to ${host}:${port}. Open Blender and click "Start MCP Server" in the MCP tab.`,
  });
});
