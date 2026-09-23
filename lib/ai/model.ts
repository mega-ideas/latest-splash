/**
 * Which Claude model 0xWal runs on, in exactly one place.
 *
 * The default used to be `claude-sonnet-4-6`, repeated in four files. That
 * model id does not exist. With `ANTHROPIC_API_KEY` set, every call threw, was
 * caught, and fell back to the canned grounded responder — after the chat
 * route had already told the client `source: 'claude'`. So the assistant never
 * once reached a model, and the UI said it had. That is the whole reason it
 * did not behave like a normal AI.
 *
 * Haiku 4.5 is the genuinely lowest-cost current model and is more than
 * adequate for scoped chat, invoice extraction and intent parsing. It is
 * overridable per environment through `ANTHROPIC_MODEL`, so raising it later
 * is a config change rather than a deploy.
 */
export const DEFAULT_COPILOT_MODEL = 'claude-haiku-4-5-20251001';

export function copilotModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.ANTHROPIC_MODEL ?? '').trim();
  return configured.length > 0 ? configured : DEFAULT_COPILOT_MODEL;
}
