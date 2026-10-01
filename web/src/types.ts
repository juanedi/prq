export type ReviewState = "pending" | "approved" | "changes" | "commented";

export interface Person {
  login: string;
  avatar_url: string | null;
}

export interface Reviewer extends Person {
  state: ReviewState;
  me: boolean;
}

export interface Chain {
  id: string;
  position: number;
  total: number;
  parent: number | null;
}

export interface Item {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: Person;
  draft: boolean;
  requested_at: string;
  updated_at: string;
  additions: number;
  deletions: number;
  ci: "pass" | "fail" | "running" | null;
  reason: string;
  urgent: boolean;
  reviewers: Reviewer[];
  chain: Chain | null;
  stacked_on: string | null;
}

export interface Snapshot {
  viewer: Person;
  fetched_at: number;
  refresh_seconds: number;
  orgs: string[];
  repos: string[];
  needs_you: Item[];
  not_blocked: Item[];
}
