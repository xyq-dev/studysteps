import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StatusBanner } from './status-banner.js';

describe('@studysteps/ui export boundary', () => {
  it('renders a status banner for the scaffold state', () => {
    const markup = renderToStaticMarkup(
      createElement(StatusBanner, { message: '工程初始化中' }),
    );

    expect(markup).toContain('role="status"');
    expect(markup).toContain('工程初始化中');
  });
});
