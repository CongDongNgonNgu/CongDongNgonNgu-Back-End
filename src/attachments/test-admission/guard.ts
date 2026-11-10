import {createHash} from 'node:crypto';
import {strictJson} from './strict-json';

/** Pure inputs only. This validates an activation envelope, NOT a run manifest
 * or request/resource capability. No imports from application runtime modules. */
export interface ActivationInputs {
  activation?: {expectedSourceSha: string; expectedManifestSha256: string; expectedDeploymentId: string};
  env?: Readonly<Record<string,string | undefined>>;
  config?: {environment: string; attachments: {enabled: boolean; image: boolean; video: boolean; text: boolean}};
  platform?: string;
  arch?: string;
  execArgv?: readonly string[];
  manifest?: Buffer;
  receipt?: {service: string; branch: string; sha: string; deploymentId: string; observedAt: string};
  nowMs?: number;
}
const SERVICE = 'srv-dahnerh594qs73fp3420';
const MAXIMA = Object.freeze({durationMs:600000,attachments:4,videos:1,declaredBytes:16777216,
  authenticatedRequests:120,anonymousRequests:20,ingressBytes:33554432,
  authenticatedEgressBytes:67108864,anonymousEgressBytes:16777216,
  processingAttempts:4,processingConcurrency:1});
export type ActivationBudgets = Readonly<{[K in keyof typeof MAXIMA]: number}>;
export interface ActivationEnvelope {
  readonly schema: 1;
  readonly runId: string;
  readonly activationId: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly budgets: ActivationBudgets;
}
export interface ValidatedActivationEnvelope {
  readonly sourceSha: string;
  readonly deploymentId: string;
  readonly manifestSha256: string;
  readonly envelope: ActivationEnvelope;
}
const reject = (): never => {throw Error('TEST_ADMISSION_REJECTED');};
function record(value: unknown, keys: readonly string[]): Record<string,unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype,null].includes(Object.getPrototypeOf(value))) return reject();
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return reject();
  const result = Object.create(null) as Record<string,unknown>;
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value,key);
    if (!property || !('value' in property)) return reject();
    result[key] = property.value;
  }
  return result;
}
function canonicalDate(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return reject();
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || new Date(ms).toISOString() !== value) return reject();
  return ms;
}
const uuid = (value: unknown): value is string => typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
/** Null is the cold default; activation does not authorize I/O or any request. */
export function validateActivationEnvelope(options?: ActivationInputs): ValidatedActivationEnvelope | null {
  try {
    const activation = options?.activation;
    if (activation === undefined) return null; // Do not inspect any other option.
    const active = record(activation,['expectedSourceSha','expectedManifestSha256','expectedDeploymentId']);
    const sha = active.expectedSourceSha, hash = active.expectedManifestSha256, deployment = active.expectedDeploymentId;
    if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || typeof hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(hash) || typeof deployment !== 'string' || !/^dep-[a-z0-9-]{1,80}$/.test(deployment)) return reject();
    const {env,config,platform,arch,execArgv,manifest,receipt,nowMs} = options!;
    if (!env || !config || env.NODE_ENV !== 'test' || env.RENDER_SERVICE_ID !== SERVICE ||
        env.RENDER_GIT_BRANCH !== 'dev' || env.RENDER_GIT_COMMIT !== sha ||
        config.environment !== 'test' || platform !== 'linux' || arch !== 'x64' ||
        !Array.isArray(execArgv) || execArgv.length !== 0 ||
        ['NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH'].some(key => env[key] !== undefined && env[key] !== '') ||
        ['ATTACHMENTS_ENABLED','ATTACHMENTS_IMAGE_ENABLED','ATTACHMENTS_VIDEO_ENABLED','ATTACHMENTS_TEXT_ENABLED'].some(key => env[key] !== 'false') ||
        !config.attachments || (['enabled','image','video','text'] as const).some(key => config.attachments[key] !== false) ||
        !Number.isSafeInteger(nowMs) || !Number.isFinite(nowMs) ||
        !Buffer.isBuffer(manifest) || manifest.length < 1 || manifest.length > 65536) return reject();
    const literal = Buffer.from(manifest);
    if (createHash('sha256').update(literal).digest('hex') !== hash) return reject();
    const root = record(strictJson(literal),['schema','runId','activationId','notBefore','expiresAt','budgets']);
    if (root.schema !== 1 || !uuid(root.runId) || !uuid(root.activationId)) return reject();
    const parsedBudgets = record(root.budgets,Object.keys(MAXIMA));
    for (const key of Object.keys(MAXIMA) as (keyof typeof MAXIMA)[]) {
      const value = parsedBudgets[key];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAXIMA[key]) return reject();
    }
    const budgets = Object.freeze({...parsedBudgets}) as ActivationBudgets;
    const start = canonicalDate(root.notBefore), end = canonicalDate(root.expiresAt);
    if (end <= start || end - start > budgets.durationMs || nowMs! < start || nowMs! >= end) return reject();
    const checkedReceipt = record(receipt,['service','branch','sha','deploymentId','observedAt']);
    const observed = canonicalDate(checkedReceipt.observedAt);
    if (checkedReceipt.service !== SERVICE || checkedReceipt.branch !== 'dev' || checkedReceipt.sha !== sha ||
        checkedReceipt.deploymentId !== deployment || observed > nowMs! || nowMs! - observed > 300000) return reject();
    const envelope: ActivationEnvelope = Object.freeze({schema:1,runId:root.runId,activationId:root.activationId,
      notBefore:root.notBefore as string,expiresAt:root.expiresAt as string,budgets});
    return Object.freeze({sourceSha:sha,deploymentId:deployment,manifestSha256:hash,envelope});
  } catch { return reject(); }
}
