// EPUB: ZIP container -> OPF manifest/spine -> XHTML chapters -> existing HTML section parser.
import { readFileSync } from 'node:fs';
import { strFromU8, unzipSync } from 'fflate';
import type { ExtractedFile, Section } from '../contracts.ts';
import { htmlToSections } from './html.ts';
import { decodeEntities } from './tidy.ts';

const attr = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}=["']([^"']+)["']`, 'i').exec(tag)?.[1];

function resolvePart(from: string, target: string): string {
  const parts = from.split('/').filter(Boolean);
  for (const segment of target.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment) parts.push(segment);
  }
  return parts.join('/');
}

function chapterTitle(html: string, fallback: string): string {
  const heading = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(html)?.[1];
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  return decodeEntities((heading ?? title ?? fallback).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 110);
}

export function extractEpubBuffer(buffer: Uint8Array): ExtractedFile & { title?: string } {
  const files = unzipSync(buffer);
  if (files['META-INF/encryption.xml']) {
    throw new Error('This EPUB is protected, so BiliMind cannot read it');
  }
  const container = strFromU8(files['META-INF/container.xml'] ?? new Uint8Array());
  const rootfile = /<rootfile\b[^>]*full-path=["']([^"']+)["']/i.exec(container)?.[1];
  if (!rootfile || !files[rootfile]) throw new Error('EPUB is missing its package manifest');
  const opf = strFromU8(files[rootfile]!);
  const base = rootfile.slice(0, rootfile.lastIndexOf('/') + 1);
  const manifest = new Map<string, { href: string; media: string }>();
  for (const match of opf.matchAll(/<item\b([^>]+)>/gi)) {
    const id = attr(match[1]!, 'id');
    const href = attr(match[1]!, 'href');
    const media = attr(match[1]!, 'media-type');
    if (id && href && media) manifest.set(id, { href: resolvePart(base, decodeEntities(href)), media });
  }
  const sections: Section[] = [];
  for (const match of opf.matchAll(/<itemref\b([^>]+)>/gi)) {
    const id = attr(match[1]!, 'idref');
    const item = id ? manifest.get(id) : undefined;
    if (!item || !/xhtml|html/.test(item.media) || !files[item.href]) continue;
    const html = strFromU8(files[item.href]!);
    const parsed = htmlToSections(html);
    sections.push(...(parsed.length ? parsed : [{ locator: chapterTitle(html, id ?? 'Chapter'), page: null, text: chapterTitle(html, id ?? 'Chapter') }]));
  }
  if (!sections.length) throw new Error('EPUB contains no readable chapters');
  const title = /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1];
  return { kind: 'epub', pages: sections.length, sections, scanned_pages: [], title: title ? decodeEntities(title).trim() : undefined };
}

export async function extractEpub(absPath: string): Promise<ExtractedFile & { title?: string }> {
  return extractEpubBuffer(new Uint8Array(readFileSync(absPath)));
}
