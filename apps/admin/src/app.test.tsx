import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from './app.js';

describe('admin A02 read-only catalog', () => {
  it('renders A02 without a publish control', () => {
    const markup = renderToStaticMarkup(createElement(App));

    expect(markup).toContain('StudySteps Admin');
    expect(markup).toContain('A02 学段科目配置');
    expect(markup).toContain('只读预览');
    expect(markup).toContain('无发布');
    expect(markup).not.toContain('发布模板');
    expect(markup).not.toContain('运营概览');
  });
});
