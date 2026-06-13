import { describe, it, expect } from 'vitest';
import config from '../../lambda/lib/config.js';

describe('config', () => {
  it('has all required keys', () => {
    expect(config.region).toBeTruthy();
    expect(config.bucket).toBeTruthy();
    expect(config.kmsKeyId).toBeTruthy();
    expect(config.bedrockModel).toBeTruthy();
    expect(config.allowedOrigin).toBeTruthy();
  });

  it('defaults allowedOrigin when env var unset', () => {
    // In CI/local without ALLOWED_ORIGIN, falls back to '*'
    if (!process.env.ALLOWED_ORIGIN) {
      expect(config.allowedOrigin).toBe('*');
    } else {
      expect(config.allowedOrigin).toBe(process.env.ALLOWED_ORIGIN);
    }
  });
});
