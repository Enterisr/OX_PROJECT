import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import tar, { type Header as TarHeader } from 'tar-stream';
import { PublicGitHubReader, RepositoryReadError } from '../src/github-handler.js';

const sha = 'a'.repeat(40);
const noop = async () => {};

async function archive(entries: { name: string; body?: string | Buffer; type?: TarHeader['type']; linkname?: string }[]) {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  const reading = (async () => { for await (const chunk of pack) chunks.push(chunk as Buffer); })();
  for (const entry of entries) {
    pack.entry({ name: entry.name, type: entry.type ?? 'file', linkname: entry.linkname }, entry.body ?? '');
  }
  pack.finalize();
  await reading;
  return gzipSync(Buffer.concat(chunks));
}

function fakeGitHub(payload: Buffer, metadata = { private: false, visibility: 'public', default_branch: 'main' }) {
  const calls: { url: string; options?: RequestInit }[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = String(input);
    calls.push({ url, options });
    if (url === 'https://api.github.com/repos/owner/repo') return Response.json(metadata);
    if (url === 'https://api.github.com/repos/owner/repo/commits/main') return new Response(sha);
    if (url === `https://api.github.com/repos/owner/repo/commits/${sha}`) return new Response(sha);
    if (url === `https://codeload.github.com/owner/repo/tar.gz/${sha}`) return new Response(new Uint8Array(payload));
    throw new Error(`Unexpected URL: ${url}`);
  };
  return { reader: new PublicGitHubReader(fetcher), calls };
}

test('public repository files are read at a fixed commit without authentication', async () => {
  const payload = await archive([
    { name: 'repo-commit/', type: 'directory' },
    { name: 'repo-commit/src/index.ts', body: 'export const value = 42;' },
    { name: 'repo-commit/package.json', body: '{"name":"real-source"}' },
  ]);
  const { reader, calls } = fakeGitHub(payload);
  const stages: number[] = [];
  const snapshot = await reader.read('https://github.com/owner/repo.git', async percent => { stages.push(percent); });
  assert.equal(snapshot.commitSha, sha);
  assert.equal(snapshot.defaultBranch, 'main');
  assert.deepEqual(snapshot.files, [
    { path: 'src/index.ts', content: 'export const value = 42;' },
    { path: 'package.json', content: '{"name":"real-source"}' },
  ]);
  assert.equal(snapshot.skippedFileCount, 0);
  assert.deepEqual(stages, [15, 35, 55]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(new Headers(call.options?.headers).has('Authorization'), false);
    assert.equal(call.options?.credentials, 'omit');
    assert.equal(call.options?.redirect, 'manual');
    assert.ok(call.options?.signal);
  }
  assert.equal(new Headers(calls[1].options?.headers).get('accept'), 'application/vnd.github.sha');
});

test('an explicit commit is resolved and downloaded instead of the default branch head', async () => {
  const payload = await archive([{ name: 'repo/src/index.ts', body: 'eval(input);' }]);
  const { reader, calls } = fakeGitHub(payload);
  const snapshot = await reader.read('https://github.com/owner/repo', noop, sha.toUpperCase());
  assert.equal(snapshot.commitSha, sha);
  assert.equal(calls[1].url, `https://api.github.com/repos/owner/repo/commits/${sha}`);
  assert.equal(calls[2].url, `https://codeload.github.com/owner/repo/tar.gz/${sha}`);
  assert.ok(!calls.some(call => call.url.endsWith('/commits/main')));
});

test('invalid, missing and mismatched commits fail without falling back to the default branch', async () => {
  const invalidReader = new PublicGitHubReader(async () => { throw new Error('Must not fetch'); });
  for (const value of ['', 'main', 'abc123', '../main', 'g'.repeat(40)]) {
    await assert.rejects(invalidReader.read('https://github.com/owner/repo', noop, value), /40-character/);
  }
  for (const missing of [true, false]) {
    const calls: string[] = [];
    const reader = new PublicGitHubReader(async input => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith('/owner/repo')) return Response.json({ private: false, visibility: 'public', default_branch: 'main' });
      assert.equal(url, `https://api.github.com/repos/owner/repo/commits/${sha}`);
      return missing ? new Response(null, { status: 404 }) : new Response('b'.repeat(40));
    });
    await assert.rejects(reader.read('https://github.com/owner/repo', noop, sha), missing ? /not found/ : /different commit/);
    assert.equal(calls.length, 2);
  }
});

test('non-public or unconfirmed visibility prevents any content request', async () => {
  for (const metadata of [
    { private: true, visibility: 'private', default_branch: 'main' },
    { private: false, visibility: 'internal', default_branch: 'main' },
    { private: false, visibility: '', default_branch: 'main' },
  ]) {
    const { reader, calls } = fakeGitHub(Buffer.alloc(0), metadata);
    await assert.rejects(reader.read('https://github.com/owner/repo', noop), /Only public repositories/);
    assert.equal(calls.length, 1);
  }
});

test('private/missing repositories and GitHub rate limits have actionable errors', async () => {
  for (const [status, headers, message] of [
    [404, {}, /not found or not public/],
    [403, { 'x-ratelimit-remaining': '0' }, /rate limit/],
    [429, {}, /rate limit/],
    [409, {}, /empty/],
    [301, { location: 'http://127.0.0.1/private' }, /Repository moved/],
  ] as const) {
    let count = 0;
    const reader = new PublicGitHubReader(async () => { count++; return new Response(null, { status, headers }); });
    await assert.rejects(reader.read('https://github.com/owner/repo', noop), message);
    assert.equal(count, 1);
  }
});

test('invalid repository hosts are rejected before any network request', async () => {
  let called = false;
  const reader = new PublicGitHubReader(async () => { called = true; throw new Error('Should not fetch'); });
  for (const url of ['http://127.0.0.1/repo', 'https://github.com@evil.example/owner/repo', 'https://user:password@github.com/owner/repo']) {
    await assert.rejects(reader.read(url, noop), /Only public github.com/);
  }
  assert.equal(called, false);
});

test('binary, non-UTF-8, large files and links are skipped without following links', async () => {
  const payload = await archive([
    { name: 'repo/file.ts', body: 'const x = 1;' },
    { name: 'repo/image.png', body: Buffer.from([0, 1, 2]) },
    { name: 'repo/binary.dat', body: Buffer.from([255, 254]) },
    { name: 'repo/large.txt', body: Buffer.alloc(1024 * 1024 + 1, 65) },
    { name: 'repo/link', type: 'symlink', linkname: '/etc/passwd' },
  ]);
  const snapshot = await fakeGitHub(payload).reader.read('https://github.com/owner/repo', noop);
  assert.deepEqual(snapshot.files, [{ path: 'file.ts', content: 'const x = 1;' }]);
  assert.equal(snapshot.skippedFileCount, 4);
});

test('invalid archive paths and multiple roots are rejected', async () => {
  for (const entries of [
    [{ name: 'repo/../outside.txt', body: 'no' }],
    [{ name: '/repo/absolute.txt', body: 'no' }],
    [{ name: 'repo/a', body: 'one' }, { name: 'other/b', body: 'two' }],
    [{ name: 'repo/a', body: 'one' }, { name: 'repo/a', body: 'duplicate' }],
  ]) {
    const payload = await archive(entries);
    await assert.rejects(fakeGitHub(payload).reader.read('https://github.com/owner/repo', noop), RepositoryReadError);
  }
});

test('oversized compressed downloads, archive expansion and text totals fail without partial results', async () => {
  const oversizedDownload = Buffer.alloc(10 * 1024 * 1024 + 1);
  await assert.rejects(fakeGitHub(oversizedDownload).reader.read('https://github.com/owner/repo', noop), /download size limit/);
  const expansion = gzipSync(Buffer.alloc(20 * 1024 * 1024 + 1));
  await assert.rejects(fakeGitHub(expansion).reader.read('https://github.com/owner/repo', noop), /archive is invalid or exceeds/);
  const tooMuchText = await archive(Array.from({ length: 6 }, (_, index) => ({ name: `repo/${index}.txt`, body: Buffer.alloc(1024 * 1024, 65) })));
  await assert.rejects(fakeGitHub(tooMuchText).reader.read('https://github.com/owner/repo', noop), /5 MB text limit/);
});

test('too many archive entries and malformed archives fail clearly', async () => {
  const payload = await archive(Array.from({ length: 2001 }, (_, index) => ({ name: `repo/${index}.txt` })));
  await assert.rejects(fakeGitHub(payload).reader.read('https://github.com/owner/repo', noop), /file count limit/);
  await assert.rejects(fakeGitHub(Buffer.from('not a gzip archive')).reader.read('https://github.com/owner/repo', noop), /archive is invalid/);
});
