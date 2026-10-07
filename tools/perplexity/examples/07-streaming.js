#!/usr/bin/env node

/**
 * 07 — Streaming responses
 * Chat Completions supports SSE streaming. Tokens arrive incrementally.
 * Citations arrive in the final chunk.
 */

import 'dotenv/config';
import { chat } from '../lib/perplexity.js';

console.log('Streaming response:\n');

const { stream } = await chat(
  'Give a brief history of the Internet in 5 key milestones',
  { stream: true }
);

const decoder = new TextDecoder();
const citations = [];
let fullText = '';

for await (const chunk of stream) {
  const text = decoder.decode(chunk, { stream: true });
  const lines = text.split('\n').filter(l => l.startsWith('data: '));

  for (const line of lines) {
    const data = line.slice(6); // strip "data: "
    if (data === '[DONE]') continue;

    try {
      const parsed = JSON.parse(data);

      // Collect content deltas
      const delta = parsed.choices?.[0]?.delta?.content;
      if (delta) {
        process.stdout.write(delta);
        fullText += delta;
      }

      // Citations arrive in the final chunk
      if (parsed.citations?.length) {
        citations.push(...parsed.citations);
      }
    } catch {
      // Skip malformed chunks
    }
  }
}

console.log('\n\n--- Stream complete ---');
console.log(`${fullText.length} chars received`);
if (citations.length) {
  console.log(`\n${citations.length} citations:`);
  citations.forEach((url, i) => console.log(`  [${i + 1}] ${url}`));
}
