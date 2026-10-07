#!/usr/bin/env node

/**
 * 08 — Structured output (JSON Schema)
 * Chat Completions can return responses conforming to a JSON schema.
 * Useful for programmatic consumption of search results.
 */

import 'dotenv/config';
import { chat } from '../lib/perplexity.js';

const { answer, citations } = await chat(
  'List the top 5 most populated cities in the world with their current population estimates',
  {
    responseFormat: {
      type: 'json_schema',
      json_schema: {
        name: 'city_populations',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            cities: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  rank: { type: 'number' },
                  name: { type: 'string' },
                  country: { type: 'string' },
                  population: { type: 'number' },
                  source_year: { type: 'number' },
                },
                required: ['rank', 'name', 'country', 'population', 'source_year'],
                additionalProperties: false,
              },
            },
          },
          required: ['cities'],
          additionalProperties: false,
        },
      },
    },
  }
);

const data = JSON.parse(answer);
console.log('Structured response:\n');
console.table(data.cities);
console.log('\nCitations:', citations);
