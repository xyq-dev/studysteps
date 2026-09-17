import { useCallback, useEffect, useState } from 'react';
import { APP_NAME } from '@studysteps/contracts';
import { StatusBanner } from '@studysteps/ui';

type GradeItem = {
  id: string;
  gradeLabel: string;
  schoolSystemCode: string;
  stageCode: string;
  gradeCode: string;
  version: string;
  versionId: string;
  catalogEntryKey: string | null;
};

function familyLoginHref() {
  return `${window.location.protocol}//${window.location.hostname}:5173/`;
}

export function App() {
  const [status, setStatus] = useState('A02 学段科目配置为只读预览。本阶段目录由种子发布，没有写入口。');
  const [items, setItems] = useState<GradeItem[]>([]);
  const [needsLogin, setNeedsLogin] = useState(false);

  const loadCatalog = useCallback(async () => {
    setNeedsLogin(false);
    try {
      const response = await fetch('/v1/grade-configs', { credentials: 'include' });
      if (response.status === 401) {
        setItems([]);
        setNeedsLogin(true);
        setStatus('A02 只读。请先使用家庭端现有登录流程，登录后再回到本页读取已发布目录。后台没有发布按钮。');
        return;
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setItems([]);
        setStatus(`A02 只读。目录读取失败：${body.message ?? response.status}。后台没有发布按钮。`);
        return;
      }
      const body = (await response.json()) as { items?: GradeItem[] };
      const next = Array.isArray(body.items) ? body.items : [];
      setItems(next);
      setStatus(`A02 只读预览已加载 ${next.length} 条已发布年级。没有发布或下架按钮。`);
    } catch (error) {
      setItems([]);
      setStatus(
        `A02 只读。目录读取失败：${error instanceof Error ? error.message : '网络错误'}。后台没有发布按钮。`,
      );
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  return (
    <main>
      <p className="eyebrow">桌面管理后台</p>
      <h1>{APP_NAME} Admin</h1>
      <StatusBanner message={status} />
      <p data-testid="a02-status">{status}</p>
      <section>
        <h2>A02 学段科目配置</h2>
        <p data-testid="a02-readonly">只读预览 · 无发布</p>
        {needsLogin ? (
          <p data-testid="a02-login-hint">
            未登录，无法读取目录。请先到家庭端完成现有登录：
            <a data-testid="a02-family-login" href={familyLoginHref()}>
              打开家庭端登录
            </a>
            ，登录成功后再回到本页重新读取。
          </p>
        ) : null}
        <button type="button" data-testid="a02-reload" onClick={() => void loadCatalog()}>
          重新读取目录
        </button>
        <ul data-testid="a02-catalog">
          {items.map((item) => (
            <li key={item.id} data-testid={`a02-grade-${item.id}`}>
              {item.schoolSystemCode} · {item.gradeLabel} · 版本 {item.version}
              {item.catalogEntryKey ? ` · ${item.catalogEntryKey}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
