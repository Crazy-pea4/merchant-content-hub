import ReviewPortal from '@/components/review-portal';
export default async function ReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params; return <ReviewPortal token={token} />;
}
