import {PortablePath, xfs, npath} from '@yarnpkg/fslib';
import {createHash, BinaryLike}   from 'crypto';
import globby                     from 'globby';

import {WorkerPool}               from './WorkerPool';

export function makeHash<T extends string = string>(...args: Array<BinaryLike | null>): T {
  const hash = createHash(`sha512`);

  let acc = ``;
  for (const arg of args) {
    if (typeof arg === `string`) {
      acc += arg;
    } else if (arg) {
      if (acc) {
        hash.update(acc);
        acc = ``;
      }

      hash.update(arg);
    }
  }

  if (acc)
    hash.update(acc);

  return hash.digest(`hex`) as T;
}

let checksumPool: WorkerPool<string, string>;

export function checksumFile(path: PortablePath) {
  checksumPool ||= new WorkerPool(`
const { createHash } = require('crypto');
const { parentPort } = require('worker_threads');
const { createReadStream } = require('fs')

parentPort.on('message', async (filePath) => {
  const stream = createReadStream(filePath)
  const hash = createHash('sha512');

  stream.on('data', chunk => {
    hash.update(chunk);
  });

  stream.on('error', error => {
    throw error
  });

  stream.on('end', () => {
    parentPort.postMessage(hash.digest('hex'));
  });
});
  `);

  return checksumPool.run(npath.fromPortablePath(path));
}

export async function checksumPattern(pattern: string, {cwd}: {cwd: PortablePath}) {
  // Note: We use a two-pass glob instead of using the expandDirectories option
  // from globby, because the native implementation is broken.
  //
  // Ref: https://github.com/sindresorhus/globby/issues/147

  const dirListing = await globby(pattern, {
    cwd: npath.fromPortablePath(cwd),
    expandDirectories: false,
    onlyDirectories: true,
    unique: true,
  });

  const dirPatterns = dirListing.map(entry => {
    return `${entry}/**/*`;
  });

  const listing = await globby([pattern, ...dirPatterns], {
    cwd: npath.fromPortablePath(cwd),
    expandDirectories: false,
    onlyFiles: false,
    unique: true,
  });

  listing.sort();

  const hashes = await Promise.all(listing.map(async entry => {
    const parts: Array<Buffer> = [Buffer.from(entry)];

    const p = npath.toPortablePath(entry);
    const stat = await xfs.lstatPromise(p);

    if (stat.isSymbolicLink())
      parts.push(Buffer.from(await xfs.readlinkPromise(p)));
    else if (stat.isFile())
      parts.push(await xfs.readFilePromise(p));

    return parts.join(`\u0000`);
  }));

  const hash = createHash(`sha512`);
  for (const sub of hashes)
    hash.update(sub);

  return hash.digest(`hex`);
}
