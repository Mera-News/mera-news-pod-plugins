// The plugins here are written against one version of the pod's plugin contract. A pod that moves
// to another version fails this before it fails at boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POD_API_VERSIONS } from 'mera-news-pod/plugin-api';

test('the pinned pod still speaks the plugin contract these plugins are written for', () => {
  // The mcp plugin speaks version 1.
  assert.ok((POD_API_VERSIONS as readonly number[]).includes(1), `the pod speaks ${POD_API_VERSIONS.join(', ')}`);
});
