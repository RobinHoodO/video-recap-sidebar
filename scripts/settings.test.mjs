import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const result = await build({
  entryPoints: ['src/core.ts'], bundle: true, platform: 'node', format: 'esm', write: false,
  define: { 'import.meta.env': JSON.stringify({ VITE_OPENROUTER_KEY: 'fixture-openrouter-key' }) },
});
const { DEFAULT_SETTINGS, mergeSettings } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('fresh settings choose configured OpenRouter when retired key is absent', () => {
  assert.equal(DEFAULT_SETTINGS.provider, 'openrouter');
  assert.equal(DEFAULT_SETTINGS.model, 'openai/gpt-4o-mini');
  assert.equal(DEFAULT_SETTINGS.apiKey, 'fixture-openrouter-key');
});
test('stored empty or retired keys migrate with matching provider model and key', () => {
  for (const apiKey of [undefined, '', 'freellmapi-retired', '  freellmapi-retired  ', '" freellmapi-retired "', 'op://fixture/retired/key', '"op://fixture/retired/key"', "'op://fixture/retired/key'", '  " op://fixture/retired/key "  ', '  " "  ']) {
    const settings = mergeSettings({ provider: 'freellmapi', model: 'auto/best-chat', apiKey, focus: 'Framework' });
    assert.equal(settings.provider, 'openrouter');
    assert.equal(settings.model, 'openai/gpt-4o-mini');
    assert.equal(settings.apiKey, 'fixture-openrouter-key');
    assert.equal(settings.focus, 'Framework');
  }
});
test('explicit usable provider credentials and model preferences survive', () => {
  for (const provider of ['freellmapi', 'openai', 'anthropic', 'openrouter']) {
    const settings = mergeSettings({ provider, apiKey: 'fixture-personal-key', model: 'custom-model' });
    assert.equal(settings.provider, provider);
    assert.equal(settings.apiKey, 'fixture-personal-key');
    assert.equal(settings.model, 'custom-model');
  }
});

test('partial settings never borrow the default provider key for another provider', () => {
  assert.equal(mergeSettings({ provider: 'openai' }).apiKey, '');
});
