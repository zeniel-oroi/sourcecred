#!/bin/bash
set -eu

usage() {
    printf 'usage: build_static_site.sh --target TARGET\n'
    printf '                            [--repo OWNER/NAME [...]]\n'
    printf '                            [--feedback-url URL]\n'
    printf '                            [--cname DOMAIN]\n'
    printf '                            [--no-backend]\n'
    printf '                            [-h|--help]\n'
    printf '\n'
    printf 'Build the static SourceCred website, including example data.\n'
    printf '\n'
    printf '%s\n' '--target TARGET'
    printf '\t%s\n' 'an empty directory into which to build the site'
    printf '%s\n' '--repo OWNER/NAME'
    printf '\t%s\n' 'a GitHub repository (e.g., torvalds/linux) for which'
    printf '\t%s\n' 'to include example data'
    printf '%s\n' '--feedback-url URL'
    printf '\t%s\n' 'link for user feedback, shown on the prototype page'
    printf '%s\n' '--cname DOMAIN'
    printf '\t%s\n' 'configure DNS for a GitHub Pages site to point to'
    printf '\t%s\n' 'the provided custom domain'
    printf '%s\n' '--no-backend'
    printf '\t%s\n' 'do not run "yarn backend"; see also the SOURCECRED_BIN'
    printf '\t%s\n' 'environment variable'
    printf '%s\n' '-h|--help'
    printf '\t%s\n' 'show this message'
    printf '\n'
    printf 'Environment variables:\n'
    printf '\n'
    printf '%s\n' 'SOURCECRED_BIN'
    printf '\t%s\n' 'When using --no-backend, directory containing the'
    printf '\t%s\n' 'SourceCred executables (output of "yarn backend").'
    printf '\t%s\n' 'Default is ./bin. Ignored without --no-backend.'
}

main() {
    parse_args "$@"

    toplevel="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
    cd "${toplevel}"

    sourcecred_data=
    sourcecred_bin=
    trap cleanup EXIT

    build
}

parse_args() {
    unset SOURCECRED_FEEDBACK_URL
    BACKEND=1
    target=
    cname=
    repos=( )
    while [ $# -gt 0 ]; do
        case "$1" in
            --target)
                if [ -n "${target}" ]; then
                    die '--target specified multiple times'
                fi
                shift
                if [ $# -eq 0 ]; then die 'missing value for --target'; fi
                target="$1"
                ;;
            --repo)
                shift
                if [ $# -eq 0 ]; then die 'missing value for --repo'; fi
                repos+=( "$1" )
                ;;
           --feedback-url)
                shift
                if [ $# -eq 0 ]; then die 'missing value for --feedback-url'; fi
                if [ -n "${SOURCECRED_FEEDBACK_URL:-}" ]; then
                    die '--feedback-url specified multiple times'
                fi
                export SOURCECRED_FEEDBACK_URL="$1"
                if [ -z "${SOURCECRED_FEEDBACK_URL}" ]; then
                    die 'empty value for --feedback-url'
                fi
                ;;
            --cname)
                shift
                if [ $# -eq 0 ]; then die 'missing value for --cname'; fi
                if [ -n "${cname}" ]; then
                    die '--cname specified multiple times'
                fi
                cname="$1"
                if [ -z "${cname}" ]; then
                    die 'empty value for --cname'
                fi
                ;;
            --no-backend)
                BACKEND=0
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                printf >&2 'fatal: unknown argument: %s\n' "$1"
                exit 1
                ;;
        esac
        shift
    done
    if [ -z "${target}" ]; then
        die 'target directory not specified'
    fi
    if ! [ -e "${target}" ]; then
        mkdir -p -- "${target}"
    fi
    if ! [ -d "${target}" ]; then
        die "target is not a directory: ${target}"
    fi
    if [ "$(command ls -A "${target}" | wc -l)" != 0 ]; then
        die "target directory is nonempty: ${target}"
    fi
    target="$(readlink -e "${target}")"
    : "${SOURCECRED_BIN:=./bin}"
}

build() {
    sourcecred_data="$(mktemp -d --suffix ".sourcecred-data")"
    export SOURCECRED_DIRECTORY="${sourcecred_data}"

    if [ "${BACKEND}" -ne 0 ]; then
        sourcecred_bin="$(mktemp -d --suffix ".sourcecred-bin")"
        export SOURCECRED_BIN="${sourcecred_bin}"
        yarn
        yarn -s backend --output-path "${SOURCECRED_BIN}"
    fi
    yarn -s build --output-path "${target}"

    if [ "${#repos[@]}" -ne 0 ]; then
        for repo in "${repos[@]}"; do
            printf >&2 'info: loading repository: %s\n' "${repo}"
            NODE_PATH="./node_modules${NODE_PATH:+:${NODE_PATH}}" \
                node "${SOURCECRED_BIN:-./bin}/sourcecred.js" load "${repo}"
        done
    fi

    # Copy the SourceCred data into the appropriate API route. Using
    # `mkdir` here will fail in the case where an `api/` folder exists,
    # which is the correct behavior. (In this case, our site's
    # architecture conflicts with the required static structure, and we
    # must fail.)
    mkdir "${target}/api/"
    mkdir "${target}/api/v1/"
    # Eliminate the cache, which is only an intermediate target used to
    # load the actual data. The development server similarly forbids
    # access to the cache so that the dev and prod environments have the
    # same semantics.
    rm -rf "${sourcecred_data}/cache"
    cp -r "${sourcecred_data}" "${target}/api/v1/data"

    if [ -n "${cname:-}" ]; then
        cname_file="${target}/CNAME"
        if [ -e "${cname_file}" ]; then
            die 'CNAME file exists in static site output'
        fi
        printf '%s' "${cname}" >"${cname_file}"  # no newline
    fi
}

cleanup() {
    if [ -d "${sourcecred_data:-}" ]; then rm -rf "${sourcecred_data}"; fi
    if [ -d "${sourcecred_bin:-}" ]; then rm -rf "${sourcecred_bin}"; fi
}

die() {
    printf >&2 'fatal: %s\n' "$@"
    exit 1
}

main "$@"
