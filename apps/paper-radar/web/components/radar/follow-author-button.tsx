'use client';

import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useUiLanguage } from './ui-language';

export function FollowAuthorButton({ onClick }: { onClick: () => void }) {
  const { ui } = useUiLanguage();
  return (
    <Button
      type="button"
      variant="outline"
      className="follow-authors-entry"
      onClick={onClick}
    >
      <UserPlus size={17} aria-hidden="true" />
      {ui('添加关注作者')}
    </Button>
  );
}
