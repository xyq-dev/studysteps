import { APP_NAME } from '@studysteps/contracts';
import { StatusBanner } from '@studysteps/ui';

export function App() {
  return (
    <main>
      <p className="eyebrow">桌面管理后台</p>
      <h1>{APP_NAME} Admin</h1>
      <StatusBanner message="工程初始化中" />
    </main>
  );
}
