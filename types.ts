/**
 * types.ts
 * Shared TypeScript interfaces and Express request augmentation.
 */

// ── Database row shapes ───────────────────────────────────────────────────────

export interface DbUser {
  id:                    number;
  username:              string;
  display_name:          string;
  password_hash:         string;
  email:                 string | null;
  role:                  'admin' | 'user';
  force_password_change: 0 | 1;
  two_fa_enabled:        0 | 1;
  enabled:               0 | 1;
  created_at:            number;
  last_seen:             number | null;
  failed_login_attempts: number;
  locked_until:          number | null;
  login_locked:          0 | 1;
}

export interface DbSession {
  token:      string;
  user_id:    number;
  created_at: number;
  expires_at: number;
}

export interface DbMessage {
  id:           string;
  user_id:      number;
  text:         string | null;
  image_path:   string | null;
  view_once:    0 | 1;
  is_blurred:   0 | 1;
  reply_to_id:  string | null;
  reply_user:   string | null;
  reply_text:   string | null;
  created_at:   number;
  submitted_at: number | null;
  deleted_at:   number | null;
  deleted_by:   number | null;
  // Joined field from SELECT
  display_name?: string;
}

export interface DbReport {
  id:           number;
  message_id:   string;
  reported_by:  number;
  reported_at:  number;
  reviewed:     0 | 1;
  reviewed_by:  number | null;
  reviewed_at:  number | null;
  action_taken: string | null;
}

export interface DbOtpToken {
  id:         number;
  user_id:    number;
  token:      string;
  purpose:    '2fa_login' | 'invite';
  expires_at: number;
  used:       0 | 1;
  created_at: number;
}

export interface DbUserPreferences {
  user_id:       number;
  colour_scheme: string | null;
  enter_to_send: 0 | 1;
  push_enabled:  0 | 1;
  font_size:     number | null;
  font_family:   string | null;
  updated_at:    number | null;
}

export interface DbPushSubscription {
  id:         number;
  user_id:    number;
  endpoint:   string;
  p256dh:     string;
  auth:       string;
  created_at: number;
}

// ── Auth user (attached to req.user by middleware) ────────────────────────────

export interface AuthUser {
  id:                    number;
  username:              string;
  display_name:          string;
  role:                  'admin' | 'user';
  force_password_change: 0 | 1;
  two_fa_enabled:        0 | 1;
  enabled:               0 | 1;
}

// ── Express Request augmentation ─────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      user?:         AuthUser;
      sessionToken?: string;
    }
  }
}

// ── API response shapes ───────────────────────────────────────────────────────

export interface DbReaction {
  message_id: string;
  user_id:    number;
  emoji:      string;
  created_at: number;
}

export interface ApiPost {
  id:        string;
  user:      string;
  text:      string;
  imagePath: string | null;
  viewOnce:  boolean;
  isBlurred: boolean;
  createdAt: number;
  seenBy:    string[];
  replyUser: string | null;
  replyText: string | null;
  replyId:   string | null;
  reactions: { emoji: string; users: string[] }[];
}

export interface ApiMessagesResponse {
  posts:    ApiPost[];
  total:    number;
  typing:   string[];
  lastSeen: Record<string, number>;
}
