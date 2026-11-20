# AWS load balancer redirectors

An AWS load balancer redirector is a separate Cloud Deployment that depends on
one existing, running, managed AWS Sliver server. The selected server and
redirector must use the same AWS account, region, and VPC. The workflow creates
an internet-facing Application Load Balancer (ALB). It can forward to an
existing Sliver HTTP job on the server, including a wildcard bind reported by
Linux as `0.0.0.0` or `*`, or
create a dedicated Sliver HTTP listener on the server's private VPC address.
It does not create another EC2 instance.

## Network and listener

The ALB listens on HTTPS port 443 with an issued ACM certificate from the
deployment region. Its HTTP target group registers the selected Sliver server
instance on the chosen backend port. For a new listener, Sliver binds to the
server's private VPC address on that port. For an existing listener, the app
selects an active HTTP job and verifies its socket is owned by `sliver-server`,
bound to the private address or a wildcard, and reachable on the private
address. The ALB frontend domain must be covered by the selected certificate.

An ALB needs two public subnets in distinct Availability Zones. The deployment
can use two existing eligible subnets in the server VPC. When the managed VPC
has only the server's public subnet, the app suggests a free subnet CIDR in a
different Availability Zone and creates a second, tagged subnet. It associates
that subnet with the server's managed public route table. Discovery checks that
both selected subnets have a route to an attached internet gateway, a `/27` or
larger IPv4 range, and eight free IPv4 addresses. One selected subnet must be in
the server target's Availability Zone. The added subnet and association belong
to the redirector and are removed with it;
preexisting subnets and the server's route table remain shared resources.

The ALB has a dedicated security group that accepts IPv4 HTTPS traffic on
port 443 and allows outbound traffic only to the selected backend port on the
server security group. The workflow adds a server security group ingress rule
whose source is the ALB security group. The HTTP backend connection stays in
the same VPC. Review any preexisting server ingress rules on that backend port
separately, because those rules may allow direct access.

The target group checks `GET /` on the backend port. The app probes the
selected Sliver listener and sets the ALB success code to its observed HTTP response;
an unmatched path commonly returns `404` instead of the ALB's usual `200`.
This proves that an HTTP service answered; it does not prove that a Sliver
implant can complete a C2 exchange. The app waits for the ALB target to report
healthy. Checking the chosen HTTPS domain end to end remains a separate step.

## Domain and DNS

The deployment uses a public Route 53 hosted zone and creates an alias A
record for the selected domain. The alias points to the ALB DNS name and its
canonical hosted zone ID. The app must inspect the exact record before
creating it and refuse to overwrite a conflicting record. The saved deployment
records the alias identity and values so removal can delete only the exact
alias it created. DNS propagation and existing caches can delay public
resolution after the ALB is ready.

The AWS identity needs the Cloud Deployment EC2, ELBv2, ACM, and Route 53
permissions for the selected resources. ALB, target group, security group,
subnet, and firewall rule identities are tagged or journaled by the
deployment. On the first load balancer or target group in an AWS account,
Elastic Load Balancing automatically creates its service-linked role. That
first creation needs a narrowly scoped `iam:CreateServiceLinkedRole` grant, or
an administrator can create the role beforehand. The app does not directly
manage IAM roles or certificate ownership.

## Removal and recovery

Remove an ALB redirector before removing its parent Sliver server. Removal
deletes the owned Route 53 alias, then deletes the ALB listener, ALB, target
group, server ingress rule, ALB security group, and any subnet created for the
redirector. It stops a listener created for the redirector after AWS cleanup;
an existing Sliver HTTP job remains running. The
provider re-reads AWS ownership tags and resource bindings before deletion. It refuses
to delete a resource whose identity or ownership no longer matches the saved
deployment. A failed or interrupted removal keeps the saved resource IDs so
the operation can be retried; the provider tolerates resources already deleted
by an earlier attempt.

Unit tests use mocked AWS and Sliver responses. A disposable AWS environment
is still needed to verify ACM, DNS propagation, ALB health checks, and real
Sliver traffic end to end.

AWS references: [ALB subnet requirements](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html),
[ALB target groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html),
[HTTP health check matchers](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html),
[ALB security groups](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-update-security-groups.html),
and [ELB service-linked roles](https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/elb-service-linked-roles.html).
