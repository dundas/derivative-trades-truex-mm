import { describe, expect, test } from 'bun:test';

const PINNED_BASE =
  'FROM oven/bun:1.3.3-alpine@sha256:d2bc1fbc3afcd3d70afc2bb2544235bf559caae2a3084e9abed126e233797511';

describe('production Docker dependency installation', () => {
  test('pins the reviewed base and uses the checked-in lockfile for a frozen production install', async () => {
    const dockerfile = await Bun.file(new URL('../Dockerfile', import.meta.url)).text();
    const copyIndex = dockerfile.indexOf('COPY package.json bun.lock ./');
    const installIndex = dockerfile.indexOf('RUN bun install --production --frozen-lockfile');

    expect(dockerfile).toContain(`${PINNED_BASE}\n`);
    expect(dockerfile).not.toContain('FROM oven/bun:1.1-alpine');
    expect(copyIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(copyIndex);
    expect(dockerfile).not.toContain('RUN bun install --production\n');
  });

  test('keeps the production dependency surface on reviewed direct versions', async () => {
    const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json();

    expect(manifest.dependencies.jspurefix).toBeUndefined();
    expect(manifest.dependencies.joi).toBeUndefined();
    expect(manifest.dependencies.axios).toBe('^1.19.0');
    expect(manifest.dependencies.ws).toBe('^8.21.3');
    expect(manifest.dependencies.uuid).toBeUndefined();
    expect(manifest.devDependencies.eslint).toBeUndefined();
  });

  test('routes Bun policy tests before the Node test glob', async () => {
    const manifest = await Bun.file(new URL('../package.json', import.meta.url)).json();
    const policyCommand = 'bun test scripts/production-image-policy.test.js scripts/builtin-uuid-runtime.test.js';

    expect(manifest.scripts['test:production-image']).toBe(policyCommand);
    expect(manifest.scripts.test).toContain('bun run test:production-image && node --test tests/**/*.test.js');
  });
});
