# AWS Crackstation deployments

A Crackstation deployment depends on one running, managed AWS Sliver server. It
uses the same AWS credential, region, and VPC as that server. The worker is a
separate EC2 instance with a public Elastic IP for restricted SSH access. Its
Sliver operator profile connects to the server's **private VPC address**.

## Instance and cost selection

The app discovers offered NVIDIA CUDA GPU instances in the selected region,
keeps x86-64 families supported by the official Ubuntu 24.04 GPU base AMI,
and asks the AWS Price List Query API for exact Linux, shared-tenancy,
On-Demand compute rates. It offers the two lowest-priced compatible types
with published rates. The selector's daily estimate is the hourly compute
rate multiplied by 24; public IPv4, EBS storage, transfer, and other AWS
charges are extra. If a current rate is missing or ambiguous, that instance
is not offered. The type is checked again before launch.

The image is the latest available Amazon-owned Ubuntu 24.04 GPU base AMI with
NVIDIA drivers and CUDA. The selected subnet must have an active default
route to an internet gateway attached to the server VPC, so the restricted
public SSH address remains reachable. The worker security group accepts SSH
only from the operator-selected IPv4 CIDRs. The server security group gains a
rule allowing its multiplayer port from the worker security group, rather
than opening that port to the worker's public IP.

## Installation and lifecycle

The main process downloads the Linux/amd64 `sliver-crackstation` release,
checks its published SHA-256 digest, and stages it privately. Over SSH to the
existing Sliver server, it creates a Crackstation-only operator profile whose
endpoint is the server's private IP. It transfers the binary and profile to
the new worker over SSH, verifies the binary again, installs a dedicated
systemd service, and waits for Sliver to report the worker's host UUID,
Hashcat version, and CUDA backend. The profile is never sent to the renderer.

If installation fails after launch, the app attempts to stop the GPU instance
and retains a failed deployment with its resource IDs for reviewed removal.
The parent Sliver server cannot be removed while a dependent worker remains.
Worker start, stop, reboot, refresh, and removal use the same managed EC2
ownership checks as server deployments. Removal first deletes the worker's
server ingress rule, then terminates its owned EC2 resources. It never owns
the parent VPC, subnet, or server security group. The Crackstation operator
profile remains on the Sliver server after worker removal or an installation
failure. Current Sliver RPC and the direct server CLI do not expose a safe
profile-revocation operation; revoke that operator in the server console.

Unit tests use mocked AWS, SSH, and Sliver responses. Real image boot,
Hashcat CUDA detection, registration, and pricing availability still require
a disposable AWS environment for end-to-end validation.

References: [AWS GPU base AMI release notes](https://docs.aws.amazon.com/dlami/latest/devguide/aws-deep-learning-ami-gpubaseoss-ul2404-2026-10-28.html),
[AWS Price List Query API](https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/using-price-list-query-api.html).
