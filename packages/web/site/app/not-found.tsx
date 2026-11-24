import Link from 'next/link';
import { Empty } from '@/components/top-bar';

export default function NotFound() {
  return (
    <Empty title="This page does not exist">
      <p>
        Go back to <Link href="/" className="text-accent-foreground underline underline-offset-4">your news</Link>.
      </p>
    </Empty>
  );
}
