#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

go test ./internal/daemon ./internal/cli -count=1 -run '^(TestRuntimeRootIdentityStableDistinctAndOpaque|TestDaemonInfoCarriesBoundedProvenance|TestEnsureDaemonProvenanceRejectsSameVersionDifferentBuild|TestEnsureDaemonProvenanceAcceptsExactAndRejectsMissingIdentity|TestEnsureDaemonProvenanceRefusesStaleDaemonBeforeJoin|TestIsolatedRuntimeRootsRouteOnlyToTheirOwnDaemonSocket|TestProvenancePreflightIsRootScopedAndSanitizesResidentOutput)$'
go test ./internal/doctor -count=1 -run '^(TestBuildIdentityUsesDeterministicVCSRevision|TestBuildIdentityIsUnavailableWithoutReliableRevision)$'
