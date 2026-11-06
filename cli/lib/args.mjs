// @ts-check

/**
 * Command-line options of `npx logsifter`. Throws an Error with a message for the user on bad input.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{ azure?: string; group?: string; slot?: string; subscription?: string; name?: string; port?: number; open: boolean; help: boolean; version: boolean }} */
  const o = { open: true, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) throw new Error(`${a} needs a value.`);
      return v;
    };
    if (a === '--azure' || a === '--app') o.azure = value();
    else if (a === '-g' || a === '--resource-group') o.group = value();
    else if (a === '-s' || a === '--slot') o.slot = value();
    else if (a === '--subscription') o.subscription = value();
    else if (a === '--name') o.name = value();
    else if (a === '--port') {
      const p = Number(value());
      if (!Number.isInteger(p) || p < 0 || p > 65535) throw new Error('--port needs a number from 0 to 65535.');
      o.port = p;
    } else if (a === '--no-open') o.open = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else throw new Error(`Unknown option "${a}". Try --help.`);
  }
  if (o.azure !== undefined && o.group === undefined) throw new Error('--azure needs the resource group too: -g <resource-group>.');
  // These go to a shell on Windows (az is az.cmd), so only plain names are accepted.
  for (const [flag, v] of [['--azure', o.azure], ['-g', o.group], ['--slot', o.slot], ['--subscription', o.subscription]]) {
    if (v !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._()-]*$/.test(v)) throw new Error(`${flag} "${v}" is not a valid name.`);
  }
  return o;
}

