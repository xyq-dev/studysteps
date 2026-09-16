import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './app.js';

describe('web STP 004 shell', () => {
  it('renders S01 identity actions without fake learning completion', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('StudySteps');
    expect(markup).toContain('S01 身份与适龄引导');
    expect(markup).toContain('发送验证码');
    expect(markup).toContain('用配对码进入');
    expect(markup).not.toContain('今日任务');
    expect(markup).not.toContain('完成率');
  });
});
