// @ts-check
import { defineConfig } from 'astro/config';

// 정적 사이트(static) 출력 — Cloudflare Pages에 그대로 올라갑니다.
// 별도 어댑터 없이 dist/ 폴더가 결과물입니다.
export default defineConfig({
  site: 'https://basic.soundbluemusic.com',
});
