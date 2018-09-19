// @flow

import React, {type Node as ReactNode} from "react";
import {NodeAddress, type NodeAddressT} from "../../core/graph";
import * as N from "./nodes";
import * as R from "./relationalView";

export function getNodeDescription(view: R.RelationalView) {
  class NodeDescription extends React.Component<{|
    +address: NodeAddressT,
  |}> {
    render() {
      const address = N.fromRaw((this.props.address: any));
      const entity = view.entity(address);
      if (entity == null) {
        throw new Error(
          `unknown entity: ${NodeAddress.toString(this.props.address)}`
        );
      }
      return descriptionForEntity(entity);
    }
  }
  return NodeDescription;
}

function descriptionForEntity(e: R.Entity) {
  return R.match(
    {
      repo: (e) => <RepoDescription e={e} />,
      issue: (e) => <IssueDescription e={e} />,
      pull: (e) => <PullDescription e={e} />,
      review: (e) => <ReviewDescription e={e} />,
      comment: (e) => <CommentDescription e={e} />,
      commit: (e) => <CommitDescription e={e} />,
      userlike: (e) => <UserlikeDescription e={e} />,
    },
    e
  );
}

class EntityUrl extends React.Component<{|
  +e: R.Entity,
  +children: ReactNode,
|}> {
  render() {
    return (
      <a href={this.props.e.url()} target="_blank">
        {this.props.children}
      </a>
    );
  }
}

class RepoDescription extends React.Component<{|+e: R.Repo|}> {
  render() {
    const e = this.props.e;
    return (
      <EntityUrl e={e}>
        {e.owner()}/{e.name()}
      </EntityUrl>
    );
  }
}

class UserlikeDescription extends React.Component<{|+e: R.Userlike|}> {
  render() {
    const e = this.props.e;
    return <EntityUrl e={e}>@{e.login()}</EntityUrl>;
  }
}

class IssueDescription extends React.Component<{|+e: R.Issue|}> {
  render() {
    const e = this.props.e;
    const leader = <EntityUrl e={e}>#{e.number()}</EntityUrl>;
    return (
      <span>
        {leader}: {e.title()}
      </span>
    );
  }
}

class PullDescription extends React.Component<{|+e: R.Pull|}> {
  render() {
    const e = this.props.e;
    const leader = <EntityUrl e={e}>#{e.number()}</EntityUrl>;
    const diff = `+${e.additions()}/\u2212${e.deletions()}`;
    return (
      <span>
        {leader} {diff}: {e.title()}
      </span>
    );
  }
}

class CommentDescription extends React.Component<{|+e: R.Comment|}> {
  render() {
    const e = this.props.e;
    const leader = <EntityUrl e={e}>Comment</EntityUrl>;
    const parentDescription = descriptionForEntity(e.parent());

    return (
      <span>
        {leader} {withAuthors(e)} on {parentDescription}
      </span>
    );
  }
}

class ReviewDescription extends React.Component<{|+e: R.Review|}> {
  render() {
    const e = this.props.e;
    const leader = <EntityUrl e={e}>Review</EntityUrl>;
    const parentDescription = descriptionForEntity(e.parent());

    return (
      <span>
        {leader} {withAuthors(e)} on {parentDescription}
      </span>
    );
  }
}

// This class is included for completeness's sake and to satisfy the
// typechecker, but won't ever be seen in the frontend because the
// commit has a Git plugin prefix and will therefore by handled by the
// git plugin adapter
class CommitDescription extends React.Component<{|+e: R.Commit|}> {
  render() {
    const e = this.props.e;
    // TODO(@wchargin): Ensure the hash is unambiguous
    const shortHash = e.address().hash.slice(0, 7);
    const leader = <EntityUrl e={e}>#{shortHash}</EntityUrl>;
    return <span>Commit {leader}</span>;
  }
}

const withAuthors = (x: R.AuthoredEntity) => {
  const authors = Array.from(x.authors());
  if (authors.length === 0) {
    // ghost author - probably a deleted account
    return "";
  }
  return "by " + authors.map((x) => `@${x.login()}`).join(" & ") + " ";
};
