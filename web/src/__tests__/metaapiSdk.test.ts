import { describe, expect, it } from 'vitest';
import { explainMetaApiError, tokenProblem } from '../backend/metaapiSdk';

const part = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

describe('MetaApi tokens and errors', () => {
  it('accepts a MetaApi token and names what is wrong with anything else', () => {
    const good = `${part({ alg: 'RS512' })}.${part({ _id: 'u', accessRules: [{ id: 'metaapi-rest-api', resources: ['*:$USER_ID$:*'] }] })}.c2ln`;
    expect(tokenProblem(good)).toBeNull();
    expect(tokenProblem(`  ${good}\n`)).toBeNull();
    expect(tokenProblem('a1b2c3d4e5f6')).toMatch(/isn't a MetaApi token/);
    expect(tokenProblem(`${part({ alg: 'RS512' })}.@@@.sig`)).toMatch(/cut short/);
    expect(tokenProblem(`${part({ alg: 'RS512' })}.${part({ sub: 'x' })}.sig`)).toMatch(/no MetaApi access rules/);
  });

  it('turns MetaApi failures into something to act on', () => {
    expect(explainMetaApiError(Object.assign(new Error('Authorization token invalid'), { name: 'UnauthorizedError' }))).toMatch(/refused this token/);
    expect(explainMetaApiError(Object.assign(new Error('bad'), { name: 'ValidationError', details: 'E_AUTH' }))).toMatch(/refused that login/);
    expect(explainMetaApiError(Object.assign(new Error('x'), { name: 'ValidationError', details: { code: 'E_SRV_NOT_FOUND' } }))).toMatch(/server name/);
    expect(explainMetaApiError(new Error('ERR_NETWORK. Request URL: https://mt-provisioning-api-v1.agiliumtrade.agiliumtrade.ai'))).toMatch(/Could not reach MetaApi/);
    expect(explainMetaApiError(Object.assign(new Error('slow'), { name: 'TooManyRequestsError' }))).toMatch(/rate-limiting/);
  });
});
