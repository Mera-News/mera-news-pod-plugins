'use client';

import { Empty, TopBar } from '@/components/top-bar';
import { SearchField } from '@/components/search-field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export default function WorldPage() {
  return (
    <>
      <TopBar end={<SearchField placeholder="Search all news" />}>
        <h1 className="mr-2 text-[15px] font-semibold tracking-[-0.01em]">Top stories</h1>
        <ToggleGroup aria-label="Where" defaultValue={['world']} disabled>
          <ToggleGroupItem value="world">World</ToggleGroupItem>
        </ToggleGroup>
      </TopBar>
      <Empty title="Top stories will show here">
        <p>The biggest stories in the world and in your countries, with every publisher that reports each one. No AI ranks this page.</p>
      </Empty>
    </>
  );
}
