'use client';

import { Empty, TopBar } from '@/components/top-bar';
import { useConnection } from '@/components/session';
import { SearchField } from '@/components/search-field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export default function FeedPage() {
  const c = useConnection();
  const facts = c.kind === 'ready' ? c.status.counts.facts : 0;
  return (
    <>
      <TopBar end={<SearchField placeholder="Search your news" />}>
        <ToggleGroup aria-label="Show" defaultValue={['all']} disabled>
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="picked">Picked</ToggleGroupItem>
          <ToggleGroupItem value="left-out">Left out</ToggleGroupItem>
        </ToggleGroup>
        <span className="inline-flex h-8 items-center rounded-full border px-3 text-[13px] text-muted-foreground">Last 48 hours</span>
      </TopBar>
      {facts === 0 ? (
        <Empty title="Mera News has no profile for you yet">
          <p>Ask your assistant to set up your news profile. Each fact about you gets its own lane of news here.</p>
        </Empty>
      ) : (
        <Empty title="Your news will show here">
          <p>
            One lane for each of your {facts} {facts === 1 ? 'fact' : 'facts'}, with what was picked for you and what was left out.
          </p>
        </Empty>
      )}
    </>
  );
}
