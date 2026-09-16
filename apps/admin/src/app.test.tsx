import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './app.js';

describe('admin scaffold', () => {
  it('renders the admin identity and init status', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('StudySteps Admin');
    expect(markup).toContain('工程初始化中');
    expect(markup).not.toContain('运营概览');
    expect(markup).not.toContain('学生档案');
  });
});
