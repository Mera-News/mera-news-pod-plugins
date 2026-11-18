// The plugins here are written against one version of the pod's plugin contract. A pod that moves
// to another version fails this before it fails at boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { POD_API } from 'mera-news-pod/plugin-api';

test('the pinned pod speaks the plugin contract these plugins are written for', () => {
  assert.equal(POD_API, 1);
});
