'use strict';

/**
 * FlowDesk Pro Lead Manager — Supabase admin client for Netlify Functions.
 *
 * Provides a small, dependency-free chainable query builder over the Supabase
 * PostgREST API (mirroring the subset of @supabase/supabase-js used by the
 * voice-agent endpoints). Reads credentials from the same environment
 * variables as the rest of the project (see ../config.js).
 *
 * Supported chains:
 *   from(table).select(cols).eq(col, val).order(col, { ascending }).limit(n).maybeSingle()
 *   from(table).insert(values).select(cols).single()
 *   from(table).update(values).eq(col, val).select(cols).single()
 *
 * Each chain is thenable and resolves to { data, error } like supabase-js.
 */

const { getServerConfig } = require('../config');

class QueryBuilder {
  constructor(baseUrl, apiKey, table) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.table = table;
    this.method = 'GET';
    this.params = new URLSearchParams();
    this.body = null;
    this.headers = {};
    this._takeFirst = false;
  }

  select(columns = '*') {
    this.params.set('select', columns || '*');
    return this;
  }

  insert(values) {
    this.method = 'POST';
    this.body = values;
    this.headers.Prefer = 'return=representation';
    return this;
  }

  update(values) {
    this.method = 'PATCH';
    this.body = values;
    this.headers.Prefer = 'return=representation';
    return this;
  }

  eq(column, value) {
    this.params.append(column, `eq.${value}`);
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.params.append('order', `${column}.${ascending ? 'asc' : 'desc'}`);
    return this;
  }

  limit(n) {
    this.params.set('limit', String(n));
    return this;
  }

  single() {
    this._takeFirst = true;
    return this;
  }

  maybeSingle() {
    this._takeFirst = true;
    return this;
  }

  async _execute() {
    const query = this.params.toString();
    const url = `${this.baseUrl}/rest/v1/${this.table}${query ? `?${query}` : ''}`;
    const headers = {
      apikey: this.apiKey,
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...this.headers,
    };

    try {
      const response = await fetch(url, {
        method: this.method,
        headers,
        body: this.body === null ? null : JSON.stringify(this.body),
      });

      const text = await response.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (_) {
        parsed = text;
      }

      if (!response.ok) {
        const message =
          parsed && parsed.message
            ? parsed.message
            : typeof parsed === 'string' && parsed
              ? parsed
              : `Supabase request failed with status ${response.status}`;
        return { data: null, error: { message, status: response.status, details: parsed } };
      }

      let data = parsed;
      if (this._takeFirst) {
        data = Array.isArray(parsed) ? (parsed.length ? parsed[0] : null) : parsed;
      }

      return { data, error: null };
    } catch (err) {
      return { data: null, error: { message: err.message } };
    }
  }

  then(onFulfilled, onRejected) {
    return this._execute().then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this._execute().catch(onRejected);
  }
}

class SupabaseAdminClient {
  constructor(baseUrl, apiKey) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  from(table) {
    return new QueryBuilder(this.baseUrl, this.apiKey, table);
  }
}

let cachedClient = null;

function getSupabaseAdmin() {
  if (cachedClient) return cachedClient;

  const config = getServerConfig();
  if (!config.supabaseUrl || !config.supabaseKey) {
    throw new Error('Supabase environment variables are not configured.');
  }

  cachedClient = new SupabaseAdminClient(config.supabaseUrl.replace(/\/$/, ''), config.supabaseKey);
  return cachedClient;
}

module.exports = { getSupabaseAdmin };
