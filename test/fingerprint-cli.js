// Prints the sim fingerprint. node test/fingerprint-cli.js, deno run test/fingerprint-cli.js, or jsc -m test/fingerprint-cli.js
import { fingerprint } from './fingerprint.js';

const { hash, best } = fingerprint();
const line = JSON.stringify({ hash, best });
if (typeof console !== 'undefined' && console.log) console.log(line); else print(line);
