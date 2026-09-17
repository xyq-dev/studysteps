import { useEffect, useState } from 'react';
import { APP_NAME } from '@studysteps/contracts';
import { StatusBanner } from '@studysteps/ui';

export function App() {
  const [status, setStatus] = useState('A02 学段科目配置为只读预览。本阶段目录由种子发布，没有写入口。');
  const [items, setItems] = useState<Array<{ id: string; gradeLabel: string; schoolSystemCode: string }>>([]);

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch('/v1/grade-configs', { credentials: 'include' });
        if (!response.ok) {
          setStatus('A02 只读。未登录时无法拉取目录，后台没有发布按钮。');
          return;
        }
        const body = (await response.json()) as { items?: Array<{ id: string; gradeLabel: string; schoolSystemCode: string }> };
        setItems(body.items ?? []);
        setStatus('A02 只读预览已加载。没有发布或下架按钮。');
      } catch {
        setStatus('A02 只读。目录读取失败，后台仍无发布入口。');
      }
    })();
  }, []);

  return (
    <main>
      <p className="eyebrow">桌面管理后台</p>
      <h1>{APP_NAME} Admin</h1>
      <StatusBanner message={status} />
      <section>
        <h2>A02 学段科目配置</h2>
        <p data-testid="a02-readonly">只读预览 · 无发布</p>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              {item.schoolSystemCode} · {item.gradeLabel}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
