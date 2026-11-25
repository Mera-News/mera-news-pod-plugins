// The You page's routes: the profile and its review, the digest schedule, and the AI service. Each
// reply carries named fields only, and nothing a person typed is ever logged or sent back beyond
// what the page shows them.
import fs from 'node:fs';
import path from 'node:path';
import type { PodServices } from 'mera-news-pod/plugin-api';
import { NewsError } from './news';

const MAX_STATEMENT = 300;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const ID = /^[\w.:-]{1,100}$/;

const bad = (message: string) => new NewsError('bad_input', message, 'Check it and try again.');

/** The pod's errors are written for an assistant; these are the ones the page can meet, in its own words. */
const POD_COPY: Record<string, [string, string]> = {
  topics_pending: ['Topics for this fact are still being made.', 'Wait until they appear here, then save.'],
  unknown_fact: ['This fact is no longer saved.', 'Reload the page to see your profile as it is now.'],
};
async function inSiteWords<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const copy = POD_COPY[(e as { code?: string }).code ?? ''];
    if (copy) throw new NewsError((e as { code: string }).code, copy[0], copy[1]);
    throw e;
  }
}

/** The AI service fields as typed, trimmed; an empty optional field is left out. */
function aiFields(body: Record<string, unknown>) {
  const text = (v: unknown, max: number) => (v === undefined ? '' : typeof v === 'string' && v.trim().length <= max ? v.trim() : null);
  const baseUrl = text(body.baseUrl, 500);
  const model = text(body.model, 200);
  const relevanceModel = text(body.relevanceModel, 200);
  const apiKey = text(body.apiKey, 2000);
  if (!baseUrl || model === null || relevanceModel === null || apiKey === null) throw bad('Give the address, the models and the key as text.');
  return { baseUrl, model, relevanceModel, apiKey };
}

/** An AI service's answer can repeat the key it was sent; the pod's error never carries it on to the page. */
async function keyless<T>(apiKey: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { code?: unknown; message?: unknown; next?: unknown };
    if (apiKey && typeof err.code === 'string' && typeof err.next === 'string') {
      const hide = (t: unknown) => String(t).split(apiKey).join('[key]');
      throw new NewsError(err.code, hide(err.message), hide(err.next));
    }
    throw e;
  }
}

/** The digest schedule the mcp plugin keeps beside this plugin's data folder: one file, read by both. */
interface Digest {
  times: string[];
  everyMinutes?: number;
  lastAt?: string;
}

function readDigest(file: string): Digest {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8')) as Digest;
    return { ...d, times: Array.isArray(d.times) ? d.times.filter((t) => TIME.test(t)) : [] };
  } catch {
    return { times: [] };
  }
}

/** Written whole, by temp file and rename, the way the mcp plugin writes it. */
function writeJson(file: string, d: unknown) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(d)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function createYou(services: PodServices, dataDir: string) {
  const mcpDir = path.join(dataDir, '..', 'mcp');
  const digestFile = path.join(mcpDir, 'digest.json');
  // The assistant's session hint starts from the mcp plugin's hint.json, so an edit made here refreshes it. Counts only, the mcp plugin's shape.
  const refreshHint = async () => {
    if (!fs.existsSync(mcpDir)) return;
    try {
      const s = await services.reading.status();
      writeJson(path.join(mcpDir, 'hint.json'), { facts: s.counts.facts, toReview: s.setup?.toReview.length ?? 0, findingTopics: s.setup?.findingTopics.length ?? 0, noTopics: s.setup?.noTopics.length ?? 0 });
    } catch {
      // The next status the assistant asks for writes it.
    }
  };
  const digestView = (d: Digest) => ({ times: d.times, everyMinutes: d.everyMinutes ?? null, assistant: fs.existsSync(mcpDir) });

  /** Every saved fact, every page, with only what the page shows. */
  async function profile() {
    const facts = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const page = await services.profile.get({ offset });
      for (const f of page.facts) {
        facts.push({
          id: f.id,
          statement: f.statement,
          topicsStatus: f.topicsStatus,
          needsReview: f.needsReview,
          reviewed: !!f.reviewedAt,
          topics: f.topics.map((t) => ({ id: t.id, text: t.text, source: t.source, reviewed: t.reviewed })),
        });
      }
      offset = page.nextOffset;
    }
    return { facts };
  }

  const reads: Record<string, () => Promise<unknown>> = {
    '/api/profile/': profile,
    '/api/digest/': async () => digestView(readDigest(digestFile)),
    '/api/ai/providers/': async () => ({
      providers: services.aiService.providers().map((p) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, chatModel: p.chatModel ?? null, relevanceModel: p.relevanceModel ?? null, listsModels: p.listsModels })),
    }),
  };

  const writes: Record<string, (body: Record<string, unknown>) => Promise<unknown>> = {
    async '/api/facts/'(body) {
      const statement = typeof body.statement === 'string' ? body.statement.replace(/\s+/g, ' ').trim() : '';
      if (statement.length < 1 || statement.length > MAX_STATEMENT) throw bad(`A fact is 1 to ${MAX_STATEMENT} characters.`);
      const r = await services.profile.addFacts([statement]);
      await refreshHint();
      const conflict = r.refused[0];
      const result = conflict ? 'conflict' : r.added[0]?.retried ? 'retried' : r.added.length ? 'added' : 'already';
      return { result, ...(conflict ? { conflictsWith: conflict.conflictsWith.statement } : {}), ...(r.localCoverageWeaker ? { localCoverageWeaker: true } : {}) };
    },
    async '/api/facts/remove/'(body) {
      if (typeof body.id !== 'string' || !ID.test(body.id)) throw bad('This fact could not be found.');
      const r = await services.profile.removeFacts([body.id]);
      await refreshHint();
      // Only whether it went: the reply never repeats the fact or its topics.
      return { removed: r.removed.length === 1 };
    },
    async '/api/topics/'(body) {
      const { factId, remove } = body;
      if (typeof factId !== 'string' || !ID.test(factId)) throw bad('This fact could not be found.');
      if (!Array.isArray(remove) || remove.length > 100 || !remove.every((id) => typeof id === 'string' && ID.test(id))) throw bad('These topics could not be found.');
      const r = await inSiteWords(() => services.profile.editTopics({ remove: remove as string[], reviewed: [factId] }));
      await refreshHint();
      return { saved: true, notRemoved: r.results.filter((x) => !x.ok).length };
    },
    async '/api/digest/'(body) {
      const { times, everyMinutes } = body;
      if (!Array.isArray(times) || times.length > 48 || !times.every((t) => typeof t === 'string' && TIME.test(t))) throw bad('Each time is a time of day, such as 08:00, with at most 48.');
      if (everyMinutes !== null && !(typeof everyMinutes === 'number' && Number.isInteger(everyMinutes) && everyMinutes >= 1 && everyMinutes <= 10080)) {
        throw bad('Every so many minutes is a whole number from 1 to 10080.');
      }
      if (!fs.existsSync(mcpDir)) throw new NewsError('no_assistant', 'Your assistant shows the digest, and it is not set up on this pod.', 'Add the Mera News plugin to your AI app first.');
      // shortcut: a digest the assistant marks shown in the same instant can be counted as not shown; upgrade by moving the schedule into the pod if that is ever seen.
      const before = readDigest(digestFile);
      const next: Digest = { times: [...new Set(times as string[])].sort(), lastAt: before.lastAt ?? new Date().toISOString(), ...(everyMinutes ? { everyMinutes } : {}) };
      writeJson(digestFile, next);
      return digestView(next);
    },
    async '/api/ai/'(body) {
      const { baseUrl, model, relevanceModel, apiKey } = aiFields(body);
      if (!model) throw bad('Give the chat model.');
      if (body.reasons !== undefined && typeof body.reasons !== 'boolean') throw bad('Say whether Mera News writes a reason for each story.');
      // An empty key field keeps the saved key; an empty relevance model uses the chat model.
      await keyless(apiKey, () =>
        services.aiService.set({ baseUrl, model, ...(relevanceModel ? { relevanceModel } : {}), ...(apiKey ? { apiKey } : {}), ...(body.reasons === undefined ? {} : { reasons: body.reasons as boolean }) }),
      );
      return { set: true };
    },
    // POST so the key never sits in an address.
    async '/api/ai/models/'(body) {
      const { baseUrl, apiKey } = aiFields(body);
      const r = await keyless(apiKey, () => services.aiService.models({ baseUrl, ...(apiKey ? { apiKey } : {}) }));
      return { models: r.models.filter((m) => typeof m === 'string') };
    },
    async '/api/ai/reasons/'(body) {
      if (typeof body.on !== 'boolean') throw bad('Say whether Mera News writes a reason for each story.');
      await services.aiService.setReasons(body.on);
      return { set: true };
    },
  };

  return { reads, writes };
}
