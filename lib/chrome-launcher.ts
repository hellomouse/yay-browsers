import childProcess, { ChildProcess } from 'child_process';
import net from 'net';

const DEFAULT_CHROME_BIN = '/opt/google/chrome/chrome';

interface Options {
  binPath?: string;
  extraArgs?: string[];
  dataDir: string;
  listenPort?: number;
  browserStartTimeout?: number;
}

interface LaunchResult {
  process: ChildProcess;
  listenPort: number;
  browserDevtoolsUrl: URL;
}

export function getFreePort(): Promise<number> {
  return new Promise((resolve, _reject) => {
    let server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      let listenAddr = server.address();
      if (!listenAddr || typeof listenAddr === 'string') {
        throw new Error('unreachable');
      }
      let port = listenAddr.port;
      server.close(() => resolve(port));
    });
  });
}

export async function launchChrome(options: Options): Promise<LaunchResult> {
  let port: number;
  if (options.listenPort) {
    port = options.listenPort;
  } else {
    port = await getFreePort();
  }
  const opts: Required<Options> = {
    binPath: DEFAULT_CHROME_BIN,
    extraArgs: [],
    browserStartTimeout: 30000,
    ...options,
    listenPort: port,
  };

  let proc = childProcess.spawn(
    opts.binPath,
    [
      `--remote-debugging-port=${opts.listenPort}`,
      `--user-data-dir=${opts.dataDir}`,
      ...opts.extraArgs,
      'about:blank',
    ],
    {
      stdio: [null, 'pipe', 'pipe'],
    }
  );

  proc.stdout.resume();
  return new Promise((resolve, reject) => {
    const regex = /(?<error>Cannot start http server for devtools\.$)|^DevTools listening on (?<address>.+?)$/m;
    let buffer = Buffer.alloc(8192);
    let ptr = 0;
    let timeout = setTimeout(() => {
      bail('timed out waiting for browser');
    }, opts.browserStartTimeout);
    let stderrListener = (chunk: Buffer) => {
      ptr += chunk.copy(buffer, ptr);
      if (ptr >= buffer.length) {
        bail('no debug address found after 8192 bytes');
        return;
      }

      let matches = regex.exec(buffer.toString('utf-8'));
      if (!matches) return;
      if (matches.groups!.error) {
        bail('devtools server listen failed:\n' + buffer.toString('utf-8'));
      } else if (matches.groups!.address) {
        removeListeners();
        let addrString = matches.groups!.address;
        let addr: URL;
        try {
          addr = new URL(addrString);
        } catch (err) {
          bail(`failed to parse returned address ${JSON.stringify(addrString)}`, { cause: err });
          return;
        }
        // great API
        if (!['ws:', 'wss:'].includes(addr.protocol)) {
          bail(`unexpected protocol: ${addr.protocol}`);
          return;
        }
        let defaultPort = addr.protocol === 'wss:' ? '443' : '80';
        if ((addr.port || defaultPort) !== port.toString()) {
          bail(`bad port: expected ${port}, got ${addr.port}`);
          return;
        }
        resolve({
          process: proc,
          listenPort: port,
          browserDevtoolsUrl: addr,
        });
      }
    };
    let exitListener = (code: number | null, signal: string | null) => {
      bail(`browser unexpectedly exited with ${code ?? signal}\nlast log:\n${buffer.toString()}`);
    };
    function removeListeners() {
      clearTimeout(timeout);
      proc.stderr.removeListener('data', stderrListener);
      proc.removeListener('exit', exitListener);
      proc.stderr.resume();
    }
    function bail(...args: ConstructorParameters<typeof Error>) {
      removeListeners();
      proc.kill();
      reject(new Error(...args));
    }
    proc.stderr.on('data', stderrListener);
    proc.on('exit', exitListener);
  });
}
