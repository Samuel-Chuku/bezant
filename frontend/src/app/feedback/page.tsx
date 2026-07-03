import type { Metadata } from 'next';
import { FeedbackForm } from '@/components/feedback-form';
import { Card } from '@/components/ui';

export const metadata: Metadata = { title: 'Feedback' };

export default function FeedbackPage() {
  return (
    <main className="mx-auto max-w-lg px-4 py-10 sm:px-6">
      <h1 className="font-brand text-2xl text-fg">Feedback</h1>
      <p className="mt-1 text-sm text-muted">
        Found a bug or have an idea? Tell us — it goes straight to the team.
      </p>
      <Card className="mt-6">
        <FeedbackForm />
      </Card>
    </main>
  );
}
