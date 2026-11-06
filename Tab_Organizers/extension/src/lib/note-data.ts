import { CompanionNote } from '../types';
export const notePayload = (note: CompanionNote) => ({
  id:note.id,video_url:note.videoUrl,timestamped_url:note.timestampedUrl,video_title:note.videoTitle,
  timestamp_seconds:note.timestampSeconds,timestamp_formatted:note.timestampFormatted,comment:note.comment,
  thumbnail_url:note.thumbnailUrl,attachments:note.attachments?.length?JSON.stringify(note.attachments):null,
  created_at:new Date(note.createdAt).toISOString(),
  // Resolve ownership by URL on the server. Cached numeric IDs can be obsolete
  // after an unsave/resave or switching between device and hosted stores.
});
export function parseNote(value: any): CompanionNote {
  let attachments;try {attachments=typeof value.attachments==='string'?JSON.parse(value.attachments):value.attachments;}catch{}
  return {id:value.id,pageId:value.page_id,videoUrl:value.video_url,timestampedUrl:value.timestamped_url,
    videoTitle:value.video_title,timestampSeconds:value.timestamp_seconds,timestampFormatted:value.timestamp_formatted,
    comment:value.comment,thumbnailUrl:value.thumbnail_url,attachments,createdAt:Date.parse(value.created_at)||Date.now()};
}
