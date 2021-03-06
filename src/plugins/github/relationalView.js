// @flow

import {toCompat, fromCompat, type Compatible} from "../../util/compat";
import stringify from "json-stable-stringify";
import {parseReferences} from "./parseReferences";
import * as N from "./nodes";
import dedent from "../../util/dedent";

// Workaround for https://github.com/facebook/flow/issues/6538
import type {
  RepoAddress,
  IssueAddress,
  PullAddress,
  ReviewAddress,
  CommentAddress,
  UserlikeAddress,
} from "./nodes";
import type {
  GithubResponseJSON,
  RepositoryJSON,
  IssueJSON,
  PullJSON,
  ReviewJSON,
  CommentJSON,
  CommitJSON,
  NullableAuthorJSON,
  ReviewState,
  ReactionJSON,
  ReactionContent,
} from "./graphql";
import * as GitNode from "../git/nodes";
import * as MapUtil from "../../util/map";
import {botSet} from "./bots";

import {
  reviewUrlToId,
  issueCommentUrlToId,
  pullCommentUrlToId,
  reviewCommentUrlToId,
} from "./urlIdParse";

const COMPAT_INFO = {
  type: "sourcecred/github/relationalView",
  version: "0.2.0",
};

export class RelationalView {
  _repos: Map<N.RawAddress, RepoEntry>;
  _issues: Map<N.RawAddress, IssueEntry>;
  _pulls: Map<N.RawAddress, PullEntry>;
  _comments: Map<N.RawAddress, CommentEntry>;
  _commits: Map<N.RawAddress, CommitEntry>;
  _reviews: Map<N.RawAddress, ReviewEntry>;
  _userlikes: Map<N.RawAddress, UserlikeEntry>;
  _mapReferences: Map<N.RawAddress, N.ReferentAddress[]>;
  _mapReferencedBy: Map<N.RawAddress, N.TextContentAddress[]>;

  constructor(): void {
    this._repos = new Map();
    this._issues = new Map();
    this._pulls = new Map();
    this._comments = new Map();
    this._commits = new Map();
    this._reviews = new Map();
    this._userlikes = new Map();
    this._mapReferences = new Map();
    this._mapReferencedBy = new Map();
  }

  addData(data: GithubResponseJSON) {
    // Warning: calling `addData` can put the RelationalView in an inconistent
    // state. for example, if called with {repo: {issues: [1,2,3]}} and then with
    // {repo: {issues: [4, 5]}}, then calls to repo.issues() will only give back
    // issues 4 and 5 (although issues 1, 2, and 3 will still be in the view)
    this._addRepo(data.repository);
    this._addReferences();
  }

  /**
   * Mutate the RelationalView, by replacing all of the post bodies with
   * empty strings. Usage of this method is a convenient hack to save space,
   * as we don't currently use the bodies after the _addReferences step.
   * Also removes commit messages.
   */
  compressByRemovingBody() {
    for (const [address, post] of this._issues.entries()) {
      const compressedPost = {...post, body: ""};
      this._issues.set(address, compressedPost);
    }

    for (const [address, post] of this._pulls.entries()) {
      const compressedPost = {...post, body: ""};
      this._pulls.set(address, compressedPost);
    }

    for (const [address, post] of this._comments.entries()) {
      const compressedPost = {...post, body: ""};
      this._comments.set(address, compressedPost);
    }

    for (const [address, post] of this._reviews.entries()) {
      const compressedPost = {...post, body: ""};
      this._reviews.set(address, compressedPost);
    }

    for (const [address, post] of this._commits.entries()) {
      const compressedPost = {...post, message: ""};
      this._commits.set(address, compressedPost);
    }
  }

  *repos(): Iterator<Repo> {
    for (const entry of this._repos.values()) {
      yield new Repo(this, entry);
    }
  }

  repo(address: RepoAddress): ?Repo {
    const entry = this._repos.get(N.toRaw(address));
    return entry == null ? entry : new Repo(this, entry);
  }

  *issues(): Iterator<Issue> {
    for (const entry of this._issues.values()) {
      yield new Issue(this, entry);
    }
  }

  issue(address: IssueAddress): ?Issue {
    const entry = this._issues.get(N.toRaw(address));
    return entry == null ? entry : new Issue(this, entry);
  }

  *pulls(): Iterator<Pull> {
    for (const entry of this._pulls.values()) {
      yield new Pull(this, entry);
    }
  }

  pull(address: PullAddress): ?Pull {
    const entry = this._pulls.get(N.toRaw(address));
    return entry == null ? entry : new Pull(this, entry);
  }

  *comments(): Iterator<Comment> {
    for (const entry of this._comments.values()) {
      yield new Comment(this, entry);
    }
  }

  comment(address: CommentAddress): ?Comment {
    const entry = this._comments.get(N.toRaw(address));
    return entry == null ? entry : new Comment(this, entry);
  }

  *commits(): Iterator<Commit> {
    for (const entry of this._commits.values()) {
      yield new Commit(this, entry);
    }
  }

  commit(address: GitNode.CommitAddress): ?Commit {
    const entry = this._commits.get(N.toRaw(address));
    return entry == null ? entry : new Commit(this, entry);
  }

  *reviews(): Iterator<Review> {
    for (const entry of this._reviews.values()) {
      yield new Review(this, entry);
    }
  }

  review(address: ReviewAddress): ?Review {
    const entry = this._reviews.get(N.toRaw(address));
    return entry == null ? entry : new Review(this, entry);
  }

  *userlikes(): Iterator<Userlike> {
    for (const entry of this._userlikes.values()) {
      yield new Userlike(this, entry);
    }
  }

  userlike(address: UserlikeAddress): ?Userlike {
    const entry = this._userlikes.get(N.toRaw(address));
    return entry == null ? entry : new Userlike(this, entry);
  }

  entity(address: N.StructuredAddress): ?Entity {
    switch (address.type) {
      case "REPO":
        return this.repo(address);
      case "ISSUE":
        return this.issue(address);
      case "PULL":
        return this.pull(address);
      case "REVIEW":
        return this.review(address);
      case "COMMENT":
        return this.comment(address);
      case "USERLIKE":
        return this.userlike(address);
      case "COMMIT":
        return this.commit(address);
      default:
        throw new Error(`Unexpected address type: ${(address.type: empty)}`);
    }
  }

  *referentEntities(): Iterator<ReferentEntity> {
    yield* this.repos();
    yield* this.issues();
    yield* this.pulls();
    yield* this.reviews();
    yield* this.comments();
    yield* this.commits();
    yield* this.userlikes();
  }

  *textContentEntities(): Iterator<TextContentEntity> {
    yield* this.issues();
    yield* this.pulls();
    yield* this.reviews();
    yield* this.comments();
    yield* this.commits();
  }

  *parentEntities(): Iterator<ParentEntity> {
    yield* this.repos();
    yield* this.issues();
    yield* this.pulls();
    yield* this.reviews();
  }

  *childEntities(): Iterator<ChildEntity> {
    yield* this.issues();
    yield* this.pulls();
    yield* this.reviews();
    yield* this.comments();
  }

  *authoredEntities(): Iterator<AuthoredEntity> {
    yield* this.issues();
    yield* this.pulls();
    yield* this.reviews();
    yield* this.comments();
    yield* this.commits();
  }

  *entities(): Iterator<Entity> {
    yield* this.repos();
    yield* this.issues();
    yield* this.pulls();
    yield* this.reviews();
    yield* this.comments();
    yield* this.commits();
    yield* this.userlikes();
  }

  *reactableEntities(): Iterator<ReactableEntity> {
    yield* this.issues();
    yield* this.pulls();
    yield* this.comments();
  }

  toJSON(): RelationalViewJSON {
    const rawJSON = {
      repos: MapUtil.toObject(this._repos),
      issues: MapUtil.toObject(this._issues),
      pulls: MapUtil.toObject(this._pulls),
      reviews: MapUtil.toObject(this._reviews),
      comments: MapUtil.toObject(this._comments),
      commits: MapUtil.toObject(this._commits),
      userlikes: MapUtil.toObject(this._userlikes),
      references: MapUtil.toObject(this._mapReferences),
      referencedBy: MapUtil.toObject(this._mapReferencedBy),
    };
    return toCompat(COMPAT_INFO, rawJSON);
  }

  static fromJSON(compatJson: RelationalViewJSON): RelationalView {
    const json = fromCompat(COMPAT_INFO, compatJson);
    const rv = new RelationalView();
    rv._repos = MapUtil.fromObject(json.repos);
    rv._issues = MapUtil.fromObject(json.issues);
    rv._pulls = MapUtil.fromObject(json.pulls);
    rv._reviews = MapUtil.fromObject(json.reviews);
    rv._comments = MapUtil.fromObject(json.comments);
    rv._commits = MapUtil.fromObject(json.commits);
    rv._userlikes = MapUtil.fromObject(json.userlikes);
    rv._mapReferences = MapUtil.fromObject(json.references);
    rv._mapReferencedBy = MapUtil.fromObject(json.referencedBy);
    return rv;
  }

  _addRepo(json: RepositoryJSON) {
    const address: RepoAddress = {
      type: N.REPO_TYPE,
      owner: json.owner.login,
      name: json.name,
    };
    const entry: RepoEntry = {
      address,
      url: json.url,
      issues: json.issues.nodes.map((x) => this._addIssue(address, x)),
      pulls: json.pulls.nodes.map((x) => this._addPull(address, x)),
    };
    const raw = N.toRaw(address);
    this._repos.set(raw, entry);
    this._addCommitHistory(json);
  }

  _addCommitHistory(json: RepositoryJSON) {
    if (json.defaultBranchRef != null) {
      const target = json.defaultBranchRef.target;
      if (target.__typename === "Commit") {
        target.history.nodes.forEach((commit) => this._addCommit(commit));
      } else {
        throw new Error(
          dedent`\
            Your repo doesn't have a commit as its defaultBranchRef's target. \
            Please file a bug reproducing this error. \
            https://github.com/sourcecred/sourcecred/issues\
          `
        );
      }
    }
  }

  _addIssue(repo: RepoAddress, json: IssueJSON): IssueAddress {
    const address: IssueAddress = {
      type: N.ISSUE_TYPE,
      number: String(json.number),
      repo,
    };
    const entry: IssueEntry = {
      address,
      url: json.url,
      comments: json.comments.nodes.map((x) => this._addComment(address, x)),
      authors: this._addNullableAuthor(json.author),
      body: json.body,
      title: json.title,
      reactions: json.reactions.nodes.map((x) => this._addReaction(x)),
    };
    this._issues.set(N.toRaw(address), entry);
    return address;
  }

  _addCommit(json: CommitJSON): GitNode.CommitAddress {
    const address = {type: GitNode.COMMIT_TYPE, hash: json.oid};
    const authors =
      json.author == null ? [] : this._addNullableAuthor(json.author.user);
    const entry: CommitEntry = {
      address,
      url: json.url,
      authors,
      message: json.message,
    };
    this._commits.set(N.toRaw(address), entry);
    return address;
  }

  _addPull(repo: RepoAddress, json: PullJSON): PullAddress {
    const address: PullAddress = {
      type: N.PULL_TYPE,
      number: String(json.number),
      repo,
    };
    const mergedAs =
      json.mergeCommit == null ? null : this._addCommit(json.mergeCommit);

    const entry: PullEntry = {
      address,
      url: json.url,
      comments: json.comments.nodes.map((x) => this._addComment(address, x)),
      reviews: json.reviews.nodes.map((x) => this._addReview(address, x)),
      authors: this._addNullableAuthor(json.author),
      body: json.body,
      title: json.title,
      mergedAs,
      additions: json.additions,
      deletions: json.deletions,
      reactions: json.reactions.nodes.map((x) => this._addReaction(x)),
    };
    this._pulls.set(N.toRaw(address), entry);
    return address;
  }

  _addReview(pull: PullAddress, json: ReviewJSON): ReviewAddress {
    const address: ReviewAddress = {
      type: N.REVIEW_TYPE,
      id: reviewUrlToId(json.url),
      pull,
    };
    const entry: ReviewEntry = {
      address,
      url: json.url,
      state: json.state,
      comments: json.comments.nodes.map((x) => this._addComment(address, x)),
      body: json.body,
      authors: this._addNullableAuthor(json.author),
    };
    this._reviews.set(N.toRaw(address), entry);
    return address;
  }

  _addComment(
    parent: IssueAddress | PullAddress | ReviewAddress,
    json: CommentJSON
  ): CommentAddress {
    const id = (function() {
      switch (parent.type) {
        case N.ISSUE_TYPE:
          return issueCommentUrlToId(json.url);
        case N.PULL_TYPE:
          return pullCommentUrlToId(json.url);
        case N.REVIEW_TYPE:
          return reviewCommentUrlToId(json.url);
        default:
          throw new Error(
            `Unexpected comment parent type: ${(parent.type: empty)}`
          );
      }
    })();
    const address: CommentAddress = {type: N.COMMENT_TYPE, id, parent};
    const entry: CommentEntry = {
      address,
      url: json.url,
      authors: this._addNullableAuthor(json.author),
      body: json.body,
      reactions: json.reactions.nodes.map((x) => this._addReaction(x)),
    };
    this._comments.set(N.toRaw(address), entry);
    return address;
  }

  _addReaction(json: ReactionJSON): ReactionRecord {
    const authorAddresses = this._addNullableAuthor(json.user);
    if (authorAddresses.length !== 1) {
      throw new Error(
        `Invariant violation: Reaction with id ${json.id} did not have 1 author`
      );
    }
    return {content: json.content, user: authorAddresses[0]};
  }

  _addNullableAuthor(json: NullableAuthorJSON): UserlikeAddress[] {
    if (json == null) {
      return [];
    } else {
      const login = json.login;
      const subtype = botSet().has(login) ? N.BOT_SUBTYPE : N.USER_SUBTYPE;
      const address: UserlikeAddress = {
        type: N.USERLIKE_TYPE,
        subtype,
        login,
      };
      const entry: UserlikeEntry = {address, url: json.url};
      this._userlikes.set(N.toRaw(address), entry);
      return [address];
    }
  }

  _addReferences() {
    // TODO(perf): _addReferences regenerates all refs from scratch
    this._mapReferences = new Map();
    this._mapReferencedBy = new Map();
    // refToAddress maps a "referencing string" to the address that string refers to.
    // There are 3 kinds of valid referencing strings:
    // - A canonical URL pointing to a GitHub entity, e.g.
    //   https://github.com/sourcecred/sourcecred/pull/416
    // - A # followed by a number, such as #416
    // - An @ followed by a login name, such as @decentralion
    const refToAddress: Map<string, N.ReferentAddress> = new Map();
    for (const e: ReferentEntity of this.referentEntities()) {
      const a = e.address();
      refToAddress.set(e.url(), a);
      if (e instanceof Userlike) {
        refToAddress.set(`@${e.login()}`, a);
      }
      if (e instanceof Issue || e instanceof Pull) {
        refToAddress.set(`#${e.number()}`, a);
        refToAddress.set(
          `${e.parent().owner()}/${e.parent().name()}#${e.number()}`,
          a
        );
      }
      if (e instanceof Commit) {
        refToAddress.set(e.address().hash, a);
      }
    }
    for (const e of this.textContentEntities()) {
      const srcAddress = e.address();
      const body = e instanceof Commit ? e.message() : e.body();
      for (const {ref, refType} of parseReferences(body)) {
        const refAddress = refToAddress.get(ref);
        if (refAddress != null) {
          switch (refType) {
            case "BASIC":
              this._addReference(srcAddress, refAddress);
              break;
            case "PAIRED_WITH":
              if (refAddress.type !== N.USERLIKE_TYPE) {
                throw new Error(
                  `Invariant error: @-ref did not refer to userlike: ${stringify(
                    refAddress
                  )}`
                );
              }
              const userlike = this.userlike(refAddress);
              if (userlike == null) {
                throw new Error(
                  `Invariant error: nonexistent reference: ${stringify(
                    refAddress
                  )}`
                );
              }
              this._addExtraAuthor(e, userlike);
              break;
            default:
              throw new Error(`Unexpected refType: ${(refType: empty)}`);
          }
        }
      }
    }
  }

  _addReference(src: N.TextContentAddress, dst: N.ReferentAddress) {
    const srcRaw = N.toRaw(src);
    const referencesForSrc = this._mapReferences.get(srcRaw);
    if (referencesForSrc == null) {
      this._mapReferences.set(srcRaw, [dst]);
    } else {
      referencesForSrc.push(dst);
    }
    const dstRaw = N.toRaw(dst);
    const referencedByForDst = this._mapReferencedBy.get(dstRaw);
    if (referencedByForDst == null) {
      this._mapReferencedBy.set(dstRaw, [src]);
    } else {
      referencedByForDst.push(src);
    }
  }

  _addExtraAuthor(e: AuthoredEntity, extraAuthor: Userlike) {
    for (const existingAuthor of e.authors()) {
      if (existingAuthor.login() === extraAuthor.login()) {
        return; // user can't author the same thing twice
      }
    }
    e._entry.authors.push(extraAuthor.address());
  }

  *_referencedBy(e: ReferentEntity): Iterator<TextContentEntity> {
    const refs = this._mapReferencedBy.get(N.toRaw(e.address()));
    if (refs == null) {
      return;
    } else {
      for (const address of refs) {
        let entity: ?TextContentEntity;
        switch (address.type) {
          case "ISSUE":
            entity = this.issue(address);
            break;
          case "PULL":
            entity = this.pull(address);
            break;
          case "REVIEW":
            entity = this.review(address);
            break;
          case "COMMENT":
            entity = this.comment(address);
            break;
          case "COMMIT":
            entity = this.commit(address);
            break;
          default:
            throw new Error(
              `Unexpected referrer address type: ${(address.type: empty)}`
            );
        }
        if (entity == null) {
          throw new Error(
            `Invariant error: Reference from non-existent entity: ${stringify(
              address
            )}`
          );
        }
        yield entity;
      }
    }
  }

  *_references(e: TextContentEntity): Iterator<ReferentEntity> {
    const refs = this._mapReferences.get(N.toRaw(e.address()));
    if (refs == null) {
      return;
    } else {
      for (const address of refs) {
        let entity: ?ReferentEntity;
        switch (address.type) {
          case "REPO":
            entity = this.repo(address);
            break;
          case "ISSUE":
            entity = this.issue(address);
            break;
          case "PULL":
            entity = this.pull(address);
            break;
          case "REVIEW":
            entity = this.review(address);
            break;
          case "COMMENT":
            entity = this.comment(address);
            break;
          case "COMMIT":
            entity = this.commit(address);
            break;
          case "USERLIKE":
            entity = this.userlike(address);
            break;
          default:
            throw new Error(
              `Unexpected referent address type: ${(address.type: empty)}`
            );
        }
        if (entity == null) {
          throw new Error(
            `Invariant error: Reference to non-existent entity: ${stringify(
              address
            )}`
          );
        }
        yield entity;
      }
    }
  }
}

type ReactionRecord = {|
  +content: ReactionContent,
  +user: UserlikeAddress,
|};

type Entry =
  | RepoEntry
  | IssueEntry
  | PullEntry
  | ReviewEntry
  | CommentEntry
  | CommitEntry
  | UserlikeEntry;

export class _Entity<+T: Entry> {
  +_view: RelationalView;
  +_entry: T;
  constructor(view: RelationalView, entry: T) {
    this._view = view;
    this._entry = entry;
  }
  address(): $ElementType<T, "address"> {
    // Relevant Flow bugs:
    //   - https://github.com/facebook/flow/issues/6648
    //   - https://github.com/facebook/flow/issues/6649
    return ((this._entry: T).address: any);
  }
  url(): string {
    return this._entry.url;
  }
}

type RepoEntry = {|
  +address: RepoAddress,
  +url: string,
  +issues: IssueAddress[],
  +pulls: PullAddress[],
|};

export class Repo extends _Entity<RepoEntry> {
  constructor(view: RelationalView, entry: RepoEntry) {
    super(view, entry);
  }
  name(): string {
    return this._entry.address.name;
  }
  owner(): string {
    return this._entry.address.owner;
  }
  *issues(): Iterator<Issue> {
    for (const address of this._entry.issues) {
      const issue = this._view.issue(address);
      yield assertExists(issue, address);
    }
  }
  *pulls(): Iterator<Pull> {
    for (const address of this._entry.pulls) {
      const pull = this._view.pull(address);
      yield assertExists(pull, address);
    }
  }
  referencedBy(): Iterator<TextContentEntity> {
    return this._view._referencedBy(this);
  }
}

type IssueEntry = {|
  +address: IssueAddress,
  +title: string,
  +body: string,
  +url: string,
  +comments: CommentAddress[],
  +authors: UserlikeAddress[],
  +reactions: ReactionRecord[],
|};

export class Issue extends _Entity<IssueEntry> {
  constructor(view: RelationalView, entry: IssueEntry) {
    super(view, entry);
  }
  parent(): Repo {
    const address = this.address().repo;
    const repo = this._view.repo(address);
    return assertExists(repo, address);
  }
  number(): string {
    return this._entry.address.number;
  }
  title(): string {
    return this._entry.title;
  }
  body(): string {
    return this._entry.body;
  }
  *comments(): Iterator<Comment> {
    for (const address of this._entry.comments) {
      const comment = this._view.comment(address);
      yield assertExists(comment, address);
    }
  }
  authors(): Iterator<Userlike> {
    return getAuthors(this._view, this._entry);
  }
  references(): Iterator<ReferentEntity> {
    return this._view._references(this);
  }
  referencedBy(): Iterator<TextContentEntity> {
    return this._view._referencedBy(this);
  }
  reactions(): $ReadOnlyArray<ReactionRecord> {
    return this._entry.reactions;
  }
}

type PullEntry = {|
  +address: PullAddress,
  +title: string,
  +body: string,
  +url: string,
  +comments: CommentAddress[],
  +reviews: ReviewAddress[],
  +mergedAs: ?GitNode.CommitAddress,
  +additions: number,
  +deletions: number,
  +authors: UserlikeAddress[],
  +reactions: ReactionRecord[],
|};

export class Pull extends _Entity<PullEntry> {
  constructor(view: RelationalView, entry: PullEntry) {
    super(view, entry);
  }
  parent(): Repo {
    const address = this.address().repo;
    const repo = this._view.repo(address);
    return assertExists(repo, address);
  }
  number(): string {
    return this._entry.address.number;
  }
  title(): string {
    return this._entry.title;
  }
  body(): string {
    return this._entry.body;
  }
  additions(): number {
    return this._entry.additions;
  }
  deletions(): number {
    return this._entry.deletions;
  }
  mergedAs(): ?GitNode.CommitAddress {
    return this._entry.mergedAs;
  }
  *reviews(): Iterator<Review> {
    for (const address of this._entry.reviews) {
      const review = this._view.review(address);
      yield assertExists(review, address);
    }
  }
  *comments(): Iterator<Comment> {
    for (const address of this._entry.comments) {
      const comment = this._view.comment(address);
      yield assertExists(comment, address);
    }
  }
  authors(): Iterator<Userlike> {
    return getAuthors(this._view, this._entry);
  }
  references(): Iterator<ReferentEntity> {
    return this._view._references(this);
  }
  referencedBy(): Iterator<TextContentEntity> {
    return this._view._referencedBy(this);
  }
  reactions(): $ReadOnlyArray<ReactionRecord> {
    return this._entry.reactions;
  }
}

type ReviewEntry = {|
  +address: ReviewAddress,
  +body: string,
  +url: string,
  +comments: CommentAddress[],
  +state: ReviewState,
  +authors: UserlikeAddress[],
|};

export class Review extends _Entity<ReviewEntry> {
  constructor(view: RelationalView, entry: ReviewEntry) {
    super(view, entry);
  }
  parent(): Pull {
    const address = this.address().pull;
    const pull = this._view.pull(address);
    return assertExists(pull, address);
  }
  body(): string {
    return this._entry.body;
  }
  state(): string {
    return this._entry.state;
  }
  *comments(): Iterator<Comment> {
    for (const address of this._entry.comments) {
      const comment = this._view.comment(address);
      yield assertExists(comment, address);
    }
  }
  authors(): Iterator<Userlike> {
    return getAuthors(this._view, this._entry);
  }
  references(): Iterator<ReferentEntity> {
    return this._view._references(this);
  }
  referencedBy(): Iterator<TextContentEntity> {
    return this._view._referencedBy(this);
  }
}

type CommentEntry = {|
  +address: CommentAddress,
  +body: string,
  +url: string,
  +authors: UserlikeAddress[],
  +reactions: ReactionRecord[],
|};

export class Comment extends _Entity<CommentEntry> {
  constructor(view: RelationalView, entry: CommentEntry) {
    super(view, entry);
  }
  parent(): Pull | Issue | Review {
    const address = this.address().parent;
    let parent: ?Pull | ?Issue | ?Review;
    switch (address.type) {
      case "PULL":
        parent = this._view.pull(address);
        break;
      case "ISSUE":
        parent = this._view.issue(address);
        break;
      case "REVIEW":
        parent = this._view.review(address);
        break;
      default:
        throw new Error(`Bad parent address type: ${(address.type: empty)}`);
    }
    return assertExists(parent, address);
  }
  body(): string {
    return this._entry.body;
  }
  authors(): Iterator<Userlike> {
    return getAuthors(this._view, this._entry);
  }
  references(): Iterator<ReferentEntity> {
    return this._view._references(this);
  }
  referencedBy(): Iterator<TextContentEntity> {
    return this._view._referencedBy(this);
  }
  reactions(): $ReadOnlyArray<ReactionRecord> {
    return this._entry.reactions;
  }
}

type CommitEntry = {|
  +address: GitNode.CommitAddress,
  +url: string,
  +authors: UserlikeAddress[],
  +message: string,
|};

export class Commit extends _Entity<CommitEntry> {
  constructor(view: RelationalView, entry: CommitEntry) {
    super(view, entry);
  }
  authors(): Iterator<Userlike> {
    return getAuthors(this._view, this._entry);
  }
  message(): string {
    return this._entry.message;
  }
  references(): Iterator<ReferentEntity> {
    return this._view._references(this);
  }
  referencedBy(): Iterator<TextContentEntity> {
    return this._view._referencedBy(this);
  }
}

type UserlikeEntry = {|
  +address: UserlikeAddress,
  +url: string,
|};

export class Userlike extends _Entity<UserlikeEntry> {
  constructor(view: RelationalView, entry: UserlikeEntry) {
    super(view, entry);
  }
  login(): string {
    return this.address().login;
  }
  referencedBy(): Iterator<TextContentEntity> {
    return this._view._referencedBy(this);
  }
}

function assertExists<T>(item: ?T, address: N.StructuredAddress): T {
  if (item == null) {
    throw new Error(
      `Invariant violation: Expected entity for ${stringify(address)}`
    );
  }
  return item;
}

function* getAuthors(
  view: RelationalView,
  entry: IssueEntry | PullEntry | ReviewEntry | CommentEntry | CommitEntry
) {
  for (const address of entry.authors) {
    const author = view.userlike(address);
    yield assertExists(author, address);
  }
}

export type MatchHandlers<T> = {|
  +repo: (x: Repo) => T,
  +issue: (x: Issue) => T,
  +pull: (x: Pull) => T,
  +review: (x: Review) => T,
  +comment: (x: Comment) => T,
  +commit: (x: Commit) => T,
  +userlike: (x: Userlike) => T,
|};
export function match<T>(handlers: MatchHandlers<T>, x: Entity): T {
  if (x instanceof Repo) {
    return handlers.repo(x);
  }
  if (x instanceof Issue) {
    return handlers.issue(x);
  }
  if (x instanceof Pull) {
    return handlers.pull(x);
  }
  if (x instanceof Review) {
    return handlers.review(x);
  }
  if (x instanceof Comment) {
    return handlers.comment(x);
  }
  if (x instanceof Commit) {
    return handlers.commit(x);
  }
  if (x instanceof Userlike) {
    return handlers.userlike(x);
  }
  throw new Error(`Unexpected entity ${x}`);
}

export type Entity = Repo | Issue | Pull | Review | Comment | Commit | Userlike;
export type AuthoredEntity = Issue | Pull | Review | Comment | Commit;
export type TextContentEntity = Issue | Pull | Review | Comment | Commit;
export type ParentEntity = Repo | Issue | Pull | Review;
export type ChildEntity = Issue | Pull | Review | Comment;
export type ReferentEntity =
  | Repo
  | Issue
  | Pull
  | Review
  | Comment
  | Commit
  | Userlike;
export type ReactableEntity = Issue | Pull | Comment;

export opaque type AddressEntryMapJSON<T> = {[N.RawAddress]: T};
export opaque type RelationalViewJSON = Compatible<{|
  +repos: AddressEntryMapJSON<RepoEntry>,
  +issues: AddressEntryMapJSON<IssueEntry>,
  +pulls: AddressEntryMapJSON<PullEntry>,
  +reviews: AddressEntryMapJSON<ReviewEntry>,
  +comments: AddressEntryMapJSON<CommentEntry>,
  +commits: AddressEntryMapJSON<CommitEntry>,
  +userlikes: AddressEntryMapJSON<UserlikeEntry>,
  +references: AddressEntryMapJSON<N.ReferentAddress[]>,
  +referencedBy: AddressEntryMapJSON<N.TextContentAddress[]>,
|}>;
