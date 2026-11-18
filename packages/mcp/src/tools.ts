import { McpServer, type CallToolResult, type StandardSchemaWithJSON, type ToolAnnotations } from '@modelcontextprotocol/server';
import type { PickView, PluginContext, PodStatus } from 'mera-news-pod/plugin-api';
import { z } from 'zod';
import { fail, fit, ok, TARGET_TOKENS } from './reply';
import { descriptions, instructions, prompts } from './text';

const statements = z.array(z.string().min(1).max(300)).min(1).max(10);
const ids = z.array(z.string().min(1)).min(1).max(20);

const schemas = {
  get_profile: z.object({ offset: z.number().int().min(0).optional() }),
  add_facts: z.object({ statements }),
  remove_facts: z.object({ ids }),
  edit_topics: z.object({
    remove: z.array(z.string().min(1)).optional(),
    weight: z.array(z.object({ topicId: z.string().min(1), weight: z.number().min(-1).max(1) })).optional(),
  }),
  get_suggestions: z.object({
    since: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  get_status: z.object({}),
  set_reading: z.object({
    paused: z.boolean().optional(),
    everyMinutes: z.number().int().min(5).max(1440).optional(),
  }),
};

const readOnly: ToolAnnotations = { readOnlyHint: true };
const writes: ToolAnnotations = { readOnlyHint: false, destructiveHint: false };
const destructive: ToolAnnotations = { readOnlyHint: false, destructiveHint: true };

/**
 * The SDK would answer a bad argument with the validator's own text. This keeps the advertised
 * input schema but lets every call through, so the handler can answer in the plugin's error shape.
 */
function advertise(schema: z.ZodType): StandardSchemaWithJSON {
  const std = (schema as unknown as { '~standard': Record<string, unknown> })['~standard'];
  return { '~standard': { ...std, validate: (value: unknown) => ({ value: value ?? {} }) } } as unknown as StandardSchemaWithJSON;
}

// Only the named fields leave: a service that ever hands back article text is not passed through.
// Text from a feed is capped, so one pick always fits a reply on its own.
const pickOut = (p: PickView): PickView => ({
  id: p.id,
  title: p.title.slice(0, 500),
  publication: p.publication.slice(0, 200),
  url: p.url,
  publishedAt: p.publishedAt,
  level: p.level,
  lang: p.lang,
  reason: p.reason.slice(0, 1000),
  facts: p.facts.slice(0, 10),
});

/** Room left in a reply for its state, hint, cursor and the like. */
const ENVELOPE_TOKENS = 400;

const saysCode = (e: unknown): e is { code: string; message: string; next: string } =>
  e instanceof Error && typeof (e as { code?: unknown }).code === 'string' && typeof (e as { next?: unknown }).next === 'string';

export function buildServer(ctx: PluginContext): McpServer {
  const { services, estimateTokens: estimate } = ctx;
  const server = new McpServer({ name: 'mera-news-pod-mcp', version: '0.1.0' }, { instructions });

  function tool<K extends keyof typeof schemas>(
    name: K,
    annotations: ToolAnnotations,
    run: (input: z.output<(typeof schemas)[K]>) => Promise<CallToolResult>,
  ) {
    server.registerTool(name, { description: descriptions[name], inputSchema: advertise(schemas[name]), annotations }, async (raw: unknown) => {
      const parsed = schemas[name].safeParse(raw);
      if (!parsed.success) {
        const field = parsed.error.issues[0]?.path.join('.') || 'input';
        return fail('bad_input', `The field "${field}" is not valid for ${name}.`, `correct "${field}" and call ${name} again`);
      }
      try {
        return await run(parsed.data as z.output<(typeof schemas)[K]>);
      } catch (e) {
        if (saysCode(e)) return fail(e.code, e.message, e.next);
        ctx.log.error(`${name} failed`);
        const message = e instanceof Error ? e.message : 'The pod could not do that.';
        return fail('failed', message, 'try again, and if it keeps failing ask the person to run node build/cli.js check in the mera-news-pod folder');
      }
    });
  }

  tool('get_profile', readOnly, async ({ offset }) => {
    const profile = await services.profile.get(offset === undefined ? undefined : { offset });
    const base = offset ?? 0;
    const make = (facts: typeof profile.facts, cut: boolean) =>
      cut ? { facts, nextOffset: base + facts.length, truncated: true } : { facts, ...(profile.nextOffset === undefined ? {} : { nextOffset: profile.nextOffset }) };
    let { kept, cut } = fit(profile.facts, make, estimate);
    if (cut && kept.length === 0 && profile.facts.length > 0) {
      // One fact with a huge topic list: show it with the topics that fit.
      const first = profile.facts[0];
      kept = [{ ...first, topics: fit(first.topics, (topics) => make([{ ...first, topics }], true), estimate).kept }];
    }
    return ok(make(kept, cut), estimate);
  });

  tool('add_facts', writes, async ({ statements }) => {
    const result = await services.profile.addFacts(statements);
    return ok({ ...result, note: 'Topics are made from the saved facts within a minute or two. Call get_profile to see them.' }, estimate);
  });

  tool('remove_facts', destructive, async ({ ids }) => ok(await services.profile.removeFacts(ids), estimate));

  tool('edit_topics', destructive, async ({ remove, weight }) =>
    ok(await services.profile.editTopics({ ...(remove ? { remove } : {}), ...(weight ? { weight } : {}) }), estimate),
  );

  tool('get_suggestions', readOnly, async ({ since, limit }) => {
    // The services cut the page until it fits and count only the picks returned as delivered.
    const fits = (picks: PickView[]) => estimate(JSON.stringify(picks.map(pickOut))) + ENVELOPE_TOKENS <= TARGET_TOKENS;
    const got = await services.suggestions.get({ ...(since ? { since } : {}), limit, fits });
    return ok({ ...got, picks: got.picks.map(pickOut) }, estimate);
  });

  const status = (s: PodStatus) => ok(s, estimate);
  tool('get_status', readOnly, async () => status(await services.reading.status()));
  tool('set_reading', destructive, async ({ paused, everyMinutes }) =>
    status(await services.reading.set({ ...(paused === undefined ? {} : { paused }), ...(everyMinutes === undefined ? {} : { everyMinutes }) })),
  );

  for (const [name, p] of Object.entries(prompts)) {
    server.registerPrompt(name, { description: p.description }, () => ({
      messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text } }],
    }));
  }
  return server;
}
